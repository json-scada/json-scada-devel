# Docker Image

This is an all-in-one docker image for JSON-SCADA based on Ubuntu 24.04.

This is a full executable docker demo for the system. It can be reconfigured and customized for your needs.

It includes

- MongoDB Community as the core database server.
- PostgreSQL/TimescaleDB for time series historian.
- Grafana for dashboards.
- IEC 60870-5-104 Client that connects to the online demo for data acquisition.
- IEC 60870-5-104 Server listening on the localhost.
- DNP3 Server.
- OPC UA Server.
- OPC UA Client.
- MQTT Sparkplug B.
- Metabase.
- And more.

## Run Instructions

Be sure to have the ports free. The ports are: 80, 9000, 4840, 2404 and 20000. Use sudo if needed.

    $DATA_DIR = "/json-scada-data" # Change this to your desired persistent data directory on the host machine.
    mkdir -p $DATA_DIR/mongodb
    mkdir -p $DATA_DIR/postgresql
    mkdir -p $DATA_DIR/grafana
    mkdir -p $DATA_DIR/svg
    mkdir -p $DATA_DIR/etc
    mkdir -p $DATA_DIR/conf
    docker pull ricardolo/json-scada:latest
    docker run -p 80:80 -p 9000:9000 -p 4840:4840 -p 2404:2404 -p 20000:20000 -d --name=json_scada -v /var/lib/postgresql:/$DATA_DIR/postgresql -v /var/lib/mongodb:/$DATA_DIR/mongodb -v /var/lib/grafana:/$DATA_DIR/grafana -v /var/lib/svg:/$DATA_DIR/svg -v /var/lib/etc:/$DATA_DIR/etc -v /var/lib/conf:/$DATA_DIR/conf ricardolo/json-scada:latest

Or with Podman

    podman pull docker.io/ricardolo/json-scada:latest
    podman run -p 80:80 -p 9000:9000 -p 4840:4840 -p 2404:2404 -p 20000:20000 -d --name=json_scada -v /var/lib/postgresql:/$DATA_DIR/postgresql -v /var/lib/mongodb:/$DATA_DIR/mongodb -v /var/lib/grafana:/$DATA_DIR/grafana -v /var/lib/svg:/$DATA_DIR/svg -v /var/lib/etc:/$DATA_DIR/etc -v /var/lib/conf:/$DATA_DIR/conf docker.io/ricardolo/json-scada:latest

## Access Instructions

Wait until images are pulled, the databases are seeded and the protocol communication begins.

Open http://127.0.0.1 on a browser (like Chrome, Safari or Firefox).

Login credentials are user="admin" and password="jsonscada".

To manage processes, access the Supervisor web interface at http://127.0.0.1:9000 (same credentials as above).

# Image build instructions

Clone the whole repository on the host computer.

    git clone --recurse-submodules https://github.com/riclolsen/json-scada --config core.autocrlf=input
    
Go to the json-scada folder to create the image.

    cd json-scada
    sudo docker build --pull --no-cache -t json-scada:latest -f Dockerfile .

