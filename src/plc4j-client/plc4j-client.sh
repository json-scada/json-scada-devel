#!/bin/sh
# {json:scada} PLC4J client launcher - requires a JRE/JDK 17+ (java in PATH or JAVA_HOME set)
# args: [instance number] [log level] [config file name] [point filter]
DIR="$(cd "$(dirname "$0")" && pwd)"
JAVA=java
[ -n "$JAVA_HOME" ] && JAVA="$JAVA_HOME/bin/java"
exec "$JAVA" -Xms32m -Xmx512m -jar "$DIR/plc4j-client.jar" "$@"
