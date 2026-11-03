# Abusix Postfix Policy Daemon

A Postfix policy daemon that feeds SMTP transaction data in real time to Abusix collectors over UDP. It always answers Postfix with `DUNNO`, so it never changes how mail is accepted, and it is designed to be as fast and as lightweight as possible.

## How it runs

The daemon runs on the mail server next to Postfix, as the systemd service in `abusix_ppd.service` (user `nobody`, restarted on failure). Postfix connects to it over TCP on `listen_port` for each SMTP transaction, through the `check_policy_service` setting below.

The master process forks one worker per CPU and replaces any worker that exits. For each transaction a worker sends one UDP datagram to every host in `feed_dest`. The datagram holds newline-separated fields: `feed_name`, a timestamp, the server port, the client address, the client's reverse DNS name (or `client_name`), the HELO name, whether ESMTP, TLS and SASL were used, and the sender's domain. An MD5 digest of those fields plus `feed_key` is appended, so the collector can authenticate the feed.

## Installation from pre-compiled nexe binaries

For convenience, the repository contains `abusix_ppd.x86` and `abusix_ppd.x64`, compiled with `nexe`. They bundle Node v12.14.0 and all dependencies and should run on any Linux. Use the x86 version on 32-bit and the x64 version on 64-bit systems.

```sh
cd /opt
git clone https://github.com/abusix/abusix_ppd.git
cd abusix_ppd
cp abusix_ppd.x64 /usr/local/bin/abusix_ppd
cp config.ini /etc/abusix_ppd.ini
# Edit /etc/abusix_ppd.ini (see Configuration)
cp abusix_ppd.service /lib/systemd/system
```

The binaries were built in December 2019 from version 1.0.1. They do not include the 1.0.2 change, which only updates the `ini` dependency.

## Installation from source

Running from source needs Node.js >= 8.

```sh
cd /opt
git clone https://github.com/abusix/abusix_ppd.git
cd abusix_ppd
npm install
# Edit config.ini (see Configuration)
# In abusix_ppd.service, switch ExecStart to the commented-out node line and fix the path
cp abusix_ppd.service /lib/systemd/system
```

## Build and deploy

There is no CI and no build script. The nexe binaries are committed to the repository, and the repo does not record the `nexe` command used to build them. Changes go to `master` through pull requests.

## Local development

There is no test suite. Run the daemon in the foreground with debug logging, which prints the loaded configuration, every connection and every datagram sent:

```sh
npm install
DEBUG=1 node index.js
```

## Configuration

The daemon reads `config.ini` from its own directory first, and falls back to a file in `/etc` when that is missing. The fallback is `/etc/abusix_ppd.ini` for the pre-compiled binaries and `/etc/abusix-ppd-reporter.ini` when running `index.js` from source.

| Setting | Default | Required | Description |
|--|--|--|--|
| `listen_port` | 9998 | N | The TCP port the policy daemon listens on. |
| `feed_name` | | Y | Identifies the feed to the collector (the Abusix `feed-id`). |
| `feed_key` | | Y | Authenticates the feed data for `feed_name` to the collector. |
| `feed_dest` | | Y | The host or `host:port` the data is sent to; the port defaults to 12211. Separate multiple destinations with commas, semicolons or spaces; the data is sent to all of them. |

The daemon refuses to start when `feed_name`, `feed_key` or `feed_dest` is missing. Setting the environment variable `DEBUG` to any non-empty value turns on debug logging.

### Postfix configuration

Edit the Postfix `main.cf` file and add the following to the start of `smtpd_sender_restrictions =` (or add that setting if it does not exist):

```
check_policy_service { inet:127.0.0.1:9998, timeout=1s, try_limit=1, default_action=DUNNO }
```

These settings ensure that Postfix is not affected if there is any problem or the policy daemon is not running.

Postfix before 3.0 may need a different line, since per-policy-client settings were introduced in 3.0.

Restart Postfix after editing `main.cf`.

## Running

`systemctl start abusix_ppd` starts the daemon and `systemctl enable abusix_ppd` starts it on boot.

The daemon can be monitored with `ps axf`, as each process title shows its current state. `total` is the total number of connections Postfix has made to the worker and `active` is the number of open connections:

```
5402 ?        Ssl    0:00 abusix_ppd (master)
 5408 ?        Sl     0:00  \_ abusix_ppd (worker) total=0 active=0
 5413 ?        Sl     0:00  \_ abusix_ppd (worker) total=0 active=0
 5414 ?        Sl     0:00  \_ abusix_ppd (worker) total=1 active=0
 5419 ?        Sl     0:00  \_ abusix_ppd (worker) total=0 active=0
```

When running from source, the master process is titled `abusix_ppd_reporter (master)`.

## License

This software is licensed under the GPLv3; see the `LICENSE` file. Please send any modifications or improvements as a pull request.
