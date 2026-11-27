//
// Abusix Real-Time SMTP Transaction Feed
// Postfix Policy daemon
//

const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const net = require('net');
const byline = require('byline');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ini = require('ini');
const DEBUG = process.env.DEBUG || false;

// Load configuration
var cfg;
try {
    cfg = ini.parse(fs.readFileSync(path.join(__dirname, './config.ini'),'utf-8'));
}
catch (e) {
    try {
        cfg = ini.parse(fs.readFileSync('/etc/abusix-ppd-reporter.ini', 'utf-8'));
    }
    catch (e2) {
        console.error(`Unable to load configuration file: ${e2.message}${(e && e.message) ? ' ' + e.message : ''}`);
        process.exit(1);
    }
}

if (DEBUG) {
    console.log(`Node version ${process.version} on ${process.platform}/${process.arch}`);
    console.log(`config: ${JSON.stringify(cfg, null, '\t')}`);
}

// Check configuration before we start-up
if (!cfg.feed_dest) console.error('feed_dest not configured');
if (!cfg.feed_name) console.error('feed_name not configured');
if (!cfg.feed_key) console.error('feed_key not configured');
if (!cfg.feed_dest || !cfg.feed_name || !cfg.feed_key) {
    console.error('Configuration errors found; not starting');
    process.exit(1);
}

// Address the policy server binds to. Postfix normally runs on the same host,
// so only listen on loopback unless the operator explicitly configures otherwise.
const listen_host = (cfg.listen_host && String(cfg.listen_host).trim()) || '127.0.0.1';
const listen_port = cfg.listen_port || 9998;

// Delay before replacing a worker that exited, so a worker that keeps crashing
// does not turn into a tight fork loop.
const REFORK_DELAY_MS = 1000;

if (cluster.isMaster) {
    process.title = "abusix_ppd_reporter (master)"
    if (DEBUG) console.log(`master ${process.pid} is started`);

    var listening_logged = false;
    cluster.on('listening', (worker, address) => {
        if (listening_logged) return;
        listening_logged = true;
        console.log(`listening on ${address.address}:${address.port}`);
    });

    // Fork workers.
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('online', (worker) => {
        if (DEBUG) console.log(`worker ${worker.id} online with PID ${worker.process.pid}`);
    });

    cluster.on('exit', (worker, code, signal) => {
        console.log(`worker ${worker.id} with PID ${worker.process.pid} died`);
        setTimeout(() => cluster.fork(), REFORK_DELAY_MS);
    });

    return;
}

// Worker
var sock = dgram.createSocket('udp4');

// Connection counters
var ca = 0;
var ct = 0;
var epoch;

function set_epoch_and_title() {
    epoch = Date.now();
    process.title = `abusix_ppd (worker) total=${ct} active=${ca}`;
}

set_epoch_and_title();

setInterval(() => {
    set_epoch_and_title();
}, 1000);

const server = net.createServer((c) => {
    ct++;
    ca++;
    if (DEBUG) console.log(`client connected: ${c.remoteAddress}:${c.remotePort}`);

    const bl = byline(c, { keepEmptyLines: true });

    var instance = null;
    var attrs = {};

    bl.on('data', (line) => {
        line = line.toString('ascii');
        if (line === '') {
            // Ignore as we get a blank entry on disconnect
            if (!Object.keys(attrs).length) return;
            // EOD
            if (instance !== attrs['instance']) {
                instance = attrs.instance;
                exports.send_data(attrs);
                attrs = {};
            }
            // Tell Postfix to move on
            c.write('action=DUNNO\n\n', 'ascii');
        }
        else {
            // Store attributes
            var pos = line.indexOf('=');
            var lhs = line.substr(0,pos);
            var rhs = line.substr(pos+1);
            attrs[lhs] = rhs;
        }
    });

    c.on('close', (err) => {
        if (err) {
            console.error(`connection from ${c.remoteAddress}:${c.remotePort} closed with error: ${err.message}`);
        }
        else {
            if (DEBUG) console.log(`client ${c.remoteAddress}:${c.remotePort} closed connection`);
        }
    });

    c.on('end', () => {
        ca--;
        if (DEBUG) console.log(`client ${c.remoteAddress}:${c.remotePort} disconnected`);
    });
});

server.on('error', (err) => {
    console.log(`server error: ${err.message}`);
});

server.listen(listen_port, listen_host, () => {
    if (DEBUG) console.log('opened server on ', server.address());
});

exports.send_data = function (attrs) {
    if (DEBUG) console.log(`received attributes: ${JSON.stringify(attrs, null, '\t')}`);
    // A request may omit sender (e.g. when the policy check is not in
    // smtpd_sender_restrictions); treat it as the null sender.
    var sender = (typeof attrs.sender === 'string') ? attrs.sender : '';
    var data = [ 
        cfg.feed_name, 
        epoch,
        attrs.server_port || '',
        attrs.client_address,
        // Always use client_name: Postfix only sets it when the reverse DNS name
        // also resolves forward to client_address (otherwise it is 'unknown').
        // reverse_client_name is not forward-confirmed and could be set to any
        // value by whoever controls the client's reverse DNS zone.
        attrs.client_name,
        attrs.helo_name,
        ((attrs.protocol_name !== undefined) ? ((attrs.protocol_name === 'ESMTP') ? 'Y' : 'N') : ''),
        ((attrs.encryption_keysize !== undefined) ? ((attrs.encryption_keysize > 0) ? 'Y' : 'N') : ''),
        ((attrs.sasl_method !== undefined) ? (attrs.sasl_method ? 'Y' : 'N') : ''),
        ((sender.indexOf('@') !== -1) ? sender.substr(sender.indexOf('@')+1) : sender),
        // Extended JSON field; not currently used
        '',
    ];

    var str = data.join("\n").toString('utf-8') + "\n";
    var digest = crypto.createHash('md5').update(str + cfg.feed_key.trim()).digest('hex');
    str += digest;

    // If multiple feed_dest are supplied, send individually to each
    cfg.feed_dest.split(/[;, ]+/g).forEach(function (dest) {
        var hp = dest.split(':');
        if (hp && hp[0]) {
            sock.send(str, hp[1] || 12211, hp[0], function (err) {
                if (err) {
                    console.error(`socket send error to ${dest}: ${err.message}`);
                }
                else {
                    if (DEBUG) console.log(`data sent to: ${dest}`);
                }
            });
        }
    });
}
