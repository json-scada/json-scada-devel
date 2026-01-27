#!/bin/sh 
JSON_SCADA_DATABASE=json_scada
sleep 5 
mongoimport --db $JSON_SCADA_DATABASE --collection protocolDriverInstances --type json --file /docker-entrypoint-initdb.d/demo_instances.json 
mongoimport --db $JSON_SCADA_DATABASE --collection protocolConnections --type json --file /docker-entrypoint-initdb.d/demo_connections_linux.json 
mongoimport --db $JSON_SCADA_DATABASE --collection realtimeData --type json --file /docker-entrypoint-initdb.d/demo_data.json 
mongoimport --db $JSON_SCADA_DATABASE --collection processInstances --type json --file /docker-entrypoint-initdb.d/demo_process_instances.json 
# mark tags as demo to make it easy to remove later
mongosh $JSON_SCADA_DATABASE --eval 'db.realtimeData.updateMany({_id:{$gt:0}},{$set:{dbId:"demo"}})'
