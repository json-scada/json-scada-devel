#!/bin/sh
# Build the Go Change Stream Data Processor.
set -e
cd "$(dirname "$0")"
CGO_ENABLED=0 go build -ldflags="-s -w" -o cs_data_processor .
echo "Built cs_data_processor"
