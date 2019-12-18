Abusix Postfix Policy Daemon
-------------------------------------

This is a Postfix Policy daemon designed to feed SMTP transaction data in real-time to a set of collectors over UDP and is designed to be as fast and as lightweight as possible.

## Installation from source
The policy daemon needs NodeJS >= 8 to be installed to function properly.
`````
cd /opt
git clone https://gitlab.com/smfreegard/abusix_ppd.git
cd abusix_ppd
npm install
# Modify abusix_ppd.service to reflect the installation path
cp abusix_ppd.service /lib/systemd/system
`````
## Installation from pre-compiled nexe binaries

For convience and to make deployment easier, you can find `abusix_ppd.x86` and `abusix_ppd.x64` files in the repository which are compiled with `nexe` and provide a bundled Node v12.14.0 LTS along with all required dependencies which should run on all versions of Linux.   Use the x86 version for 32-bit and x64 for 64-bit architectures.

`````
cd /opt
git clone https://gitlab.com/smfreegard/abusix_ppd.git
cd abusix_ppd
cp abusix_ppd.x64 /usr/local/bin/abusix_ppd
cp config.ini /etc/abusix_ppd.ini
# Modify abusix_ppd.service to reflect the installation path
cp abusix_ppd.service /lib/systemd/system
`````

## Configuration
The `config.ini` or `/etc/abusix_ppd.ini` file is used to configure the daemon:

| Configuration |Default |Required | Description |
|--|--|--|--|
|listen_port|9998|N|This is the TCP port the Policy daemon listens on.
|feed_name||Y|This identifies the feed to the collector.
|feed_key||Y|This authenticates the feed data against the `feed_name` to the collector
|feed_dest||Y|The host or host:port where the data should be sent.  If the port is not specified then it defaults to port 12211.  Multiple destinations can be specified using comma, semicolon or whitespace to delimit the hosts.  If multiple hosts are specified then the data is sent to them all.

### Postfix Configuration

Edit the Postfix `main.cf` file and add the following to the start of `smtpd_sender_restrictions =` (or add this section if it does not already exist):
`````
check_policy_service { inet:127.0.0.1:9998, timeout=1s, try_limit=1, default_action=DUNNO }
`````

These settings ensure that Postfix will not be affected at all should there be any problem or if the policy daemon is not running.

For Postfix < 3.0 this line may need to be modified as different settings per policy client were not introduced until this version.

Postfix needs to be restarted once `main.cf` has been edited.

## Running

`systemctl start abusix_ppd` will start the daemon and `systemctl enable abusix_ppd` will ensure that it starts on boot.

By default the systemd service file runs the daemon as user `nobody`.

Once started - it will fork a worker process per-CPU and it can be monitored by running `ps axf` as the process title is modified to show it's current state.   `total` is the total number connections that Postfix has made to the process and `active` is the number of active connections from Postfix:
`````
5402 ?        Ssl    0:00 abusix_ppd (master)
 5408 ?        Sl     0:00  \_ abusix_ppd (worker) total=0 active=0
 5413 ?        Sl     0:00  \_ abusix_ppd (worker) total=0 active=0
 5414 ?        Sl     0:00  \_ abusix_ppd (worker) total=1 active=0
 5419 ?        Sl     0:00  \_ abusix_ppd (worker) total=0 active=0
 5420 ?        Sl     0:00  \_ abusix_ppd (worker) total=0 active=0
 5430 ?        Sl     0:00  \_ abusix_ppd (worker) total=0 active=0
 5435 ?        Sl     0:00  \_ abusix_ppd (worker) total=0 active=0
 5446 ?        Sl     0:00  \_ abusix_ppd (worker) total=0 active=0
`````

## License
This software is licensed under the GPLv3, please see the `LICENSE` file in the same directory.   Please send any modifications or improvements as a Pull Request.
