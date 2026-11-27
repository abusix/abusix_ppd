'use strict';

// Starts the daemon as a child process against a temporary config.ini and
// talks to it like Postfix does. index.js reads config.ini from its own
// directory, so it is copied into a temporary directory next to the config.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

async function startDaemon(t, extraConfig) {
    const udp = dgram.createSocket('udp4');
    const datagrams = [];
    udp.on('message', (msg) => datagrams.push(msg.toString()));
    await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));

    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abusix_ppd-test-'));
    fs.copyFileSync(path.join(ROOT, 'index.js'), path.join(dir, 'index.js'));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(dir, 'config.ini'), [
        `listen_port=${port}`,
        'feed_name=test',
        'feed_key=secret',
        `feed_dest=127.0.0.1:${udp.address().port}`,
        ...(extraConfig || []),
    ].join('\n') + '\n');

    const child = spawn(process.execPath, [path.join(dir, 'index.js')], {
        env: { ...process.env, DEBUG: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });

    t.after(() => {
        child.kill('SIGKILL');
        udp.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // Wait for the master to report the listening address
    const deadline = Date.now() + 10000;
    while (!/listening on /.test(output)) {
        if (Date.now() > deadline) throw new Error(`daemon did not start:\n${output}`);
        await new Promise((r) => setTimeout(r, 50));
    }

    return { port, datagrams, output: () => output };
}

// Sends one policy request and resolves with the daemon's reply
function policyRequest(port, attrs) {
    return new Promise((resolve, reject) => {
        const c = net.connect(port, '127.0.0.1');
        let reply = '';
        c.setEncoding('ascii');
        c.on('error', reject);
        c.on('data', (d) => {
            reply += d;
            if (reply.endsWith('\n\n')) {
                c.end();
                resolve(reply);
            }
        });
        const body = Object.entries(attrs).map(([k, v]) => `${k}=${v}\n`).join('') + '\n';
        c.write(body);
        setTimeout(() => { c.destroy(); reject(new Error(`no reply, got: ${JSON.stringify(reply)}`)); }, 5000).unref();
    });
}

async function waitFor(fn, ms) {
    const deadline = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 25));
    }
    return true;
}

test('listens on 127.0.0.1 by default', async (t) => {
    const d = await startDaemon(t);
    assert.match(d.output(), new RegExp(`listening on 127\\.0\\.0\\.1:${d.port}\\b`));
});

test('listen_host overrides the bind address', async (t) => {
    const d = await startDaemon(t, ['listen_host=0.0.0.0']);
    assert.match(d.output(), new RegExp(`listening on 0\\.0\\.0\\.0:${d.port}\\b`));
});

test('answers DUNNO and reports the sender domain', async (t) => {
    const d = await startDaemon(t);
    const reply = await policyRequest(d.port, {
        request: 'smtpd_access_policy',
        protocol_state: 'MAIL',
        protocol_name: 'ESMTP',
        instance: 'a.1',
        client_address: '192.0.2.1',
        client_name: 'mail.example.net',
        reverse_client_name: 'mail.example.net',
        helo_name: 'mail.example.net',
        sender: 'user@example.org',
        server_port: '25',
    });
    assert.strictEqual(reply, 'action=DUNNO\n\n');
    assert.ok(await waitFor(() => d.datagrams.length === 1, 2000), 'expected one datagram');
    const fields = d.datagrams[0].split('\n');
    assert.strictEqual(fields[0], 'test');
    assert.strictEqual(fields[3], '192.0.2.1');
    assert.strictEqual(fields[4], 'mail.example.net');
    assert.strictEqual(fields[9], 'example.org');
});

test('a request without sender does not crash the worker', async (t) => {
    const d = await startDaemon(t);
    const reply = await policyRequest(d.port, {
        request: 'smtpd_access_policy',
        instance: 'b.1',
        client_address: '192.0.2.2',
        client_name: 'unknown',
    });
    assert.strictEqual(reply, 'action=DUNNO\n\n');
    assert.ok(await waitFor(() => d.datagrams.length === 1, 2000), 'expected one datagram');
    assert.strictEqual(d.datagrams[0].split('\n')[9], '');
    // Give a crashing worker time to be reported by the master
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(d.output(), /died/);
});
