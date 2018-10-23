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
    if (DEBUG) console.log(JSON.stringify({cfg: cfg}, null, '\t'));
}
catch (e) {
    console.error(`Unable to load configuration file: ${e.message}`);
    process.exit(1);
}

// Check configuration before we start-up
if (!cfg.feed_dest) console.error('feed_dest not configured');
if (!cfg.feed_name) console.error('feed_name not configured');
if (!cfg.feed_key) console.error('feed_key not configured');
if (!cfg.feed_dest || !cfg.feed_name || !cfg.feed_key) {
    console.error('Configuration errors found; not starting');
    process.exit(1);
}

if (cluster.isMaster) {
    process.title = "abusix_ppd (master)"
    if (DEBUG) console.log(`master ${process.pid} is started`);

    // Fork workers.
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('online', (worker) => {
        if (DEBUG) console.log(`worker ${worker.id} online with PID ${worker.process.pid}`);
    });

    cluster.on('exit', (worker, code, signal) => {
        console.log(`worker ${worker.id} with PID ${worker.process.pid} died`);
        cluster.fork();
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
            c.write('action=DUNNO\n\n', { encoding: 'ascii' });
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

server.listen(cfg.listen_port || 9998, () => {
    if (DEBUG) console.log('opened server on ', server.address());
});

exports.send_data = function (attrs) {
    if (DEBUG) console.log(`received attributes: ${JSON.stringify(attrs, null, '\t')}`);
    var data = [ 
        cfg.feed_name, 
        epoch,
        attrs.server_port || '',
        attrs.client_address,
        // Use the client_reverse_name if we can, otherwise use client_name
        ((attrs.client_reverse_name !== undefined) 
            ? (attrs.client_reverse_name !== 'unknown' ? attrs.client_reverse_name : attrs.client_name)
            : attrs.client_name),
        attrs.helo_name,
        ((attrs.protocol_name !== undefined) ? ((attrs.protocol_name === 'ESMTP') ? 'Y' : 'N') : ''),
        ((attrs.encryption_keysize !== undefined) ? ((attrs.encryption_keysize > 0) ? 'Y' : 'N') : ''),
        ((attrs.sasl_method !== undefined) ? (attrs.sasl_method ? 'Y' : 'N') : ''),
        ((attrs.sender.indexOf('@') !== -1) ? attrs.sender.substr(attrs.sender.indexOf('@')+1) : attrs.sender),
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
