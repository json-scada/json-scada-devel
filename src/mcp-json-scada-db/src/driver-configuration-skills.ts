/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PROTOCOL_DRIVERS,
  PROTOCOL_DRIVER_NAMES,
  srcDir,
  type ProtocolDriverName,
} from './jsonscada/drivers.js'

interface DriverSetup {
  focus: string
  checks: string[]
  reference?: string
}

const SETUP: Record<ProtocolDriverName, DriverSetup> = {
  'IEC60870-5-104': {
    focus: 'IEC 104 telecontrol acquisition over TCP or TLS',
    checks: [
      'Set ipAddresses to the station endpoints (at most two alternatives for the same point map). Match the originator address, ASDU parameters, interrogation interval and station TLS requirements.',
      'Confirm the ASDU common address, information object address (IOA) and type of each supervised point. Use autoCreateTags when discovery is intended.',
    ],
  },
  'IEC60870-5-104_SERVER': {
    focus: 'an IEC 104 listener and its exported point map',
    checks: [
      'Set ipAddressLocalBind and put the permitted master IPs in ipAddresses. An empty list permits any peer at this layer. Match the master’s ASDU parameters and configure TLS when required.',
      'Map existing tags through protocolDestinations. Confirm unique common-address/IOA pairs, types and interrogation groups.',
    ],
  },
  'IEC60870-5-101': {
    focus: 'IEC 101 serial or FT1.2-over-TCP acquisition',
    checks: [
      'Set portName to the serial device or FT1.2 tunnel endpoint. For serial, match baud rate, data bits, parity and stop bits.',
      'Agree on link addressing and ASDU field sizes. Map points by common address, IOA and type, then check interrogation on a known station point.',
    ],
  },
  'IEC60870-5-101_SERVER': {
    focus: 'IEC 101 serial distribution and master interrogation',
    checks: [
      'Confirm the serial device or FT1.2 tunnel in portName, framing settings, localLinkAddress, and link and ASDU field sizes with the master.',
      'Set protocolDestinations on the intended tags. Check that common-address/IOA pairs are unique and that station and group interrogation return the expected points.',
    ],
  },
  'IEC60870-5-103': {
    focus: 'IEC 103 protection device acquisition and FUN/INF addressing',
    checks: [
      'Set portName to the serial device or FT1.2-over-TCP endpoint and remoteLinkAddress to the device link address. Match the framing for a physical port.',
      'Use the device link address as the source common address and FUN * 65536 + INF * 256 + index as the object address. Confirm the relay point list and event timestamps.',
      'Check the platform-installed IEC 103 service when MCP process management does not report a manageable instance.',
    ],
  },
  IEC61850: {
    focus: 'IEC 61850 MMS client associations, reports and tag mapping',
    checks: [
      'Set the MMS endpoint in ipAddresses. Specify the port explicitly for MMS over TLS and configure certificate trust for the IED.',
      'Use the MMS object reference for protocolSourceObjectAddress and the functional constraint (for example ST or MX) for protocolSourceCommonAddress. Verify report and poll behavior on known points.',
    ],
  },
  IEC61850_SERVER: {
    focus: 'an IEC 61850 MMS gateway and its generated IED model',
    checks: [
      'Set the listener and client allowlist with ipAddressLocalBind and ipAddresses. The connection name determines the generated IED name. Use topics to scope exposed group1 values.',
      'Size maxClientConnections and maxQueueSize for the intended clients and buffered reports. Verify the generated model, data sets and reports with an MMS client.',
    ],
  },
  DNP3: {
    focus: 'a DNP3 master connection to an outstation',
    reference: 'dnp3-go/cmd/dnp3client/README.md',
    checks: [
      'Choose connectionMode for the agreed TCP, TLS, UDP or serial transport. Match the endpoints and localLinkAddress / remoteLinkAddress to the master and outstation.',
      'Map each point by DNP3 object family and index, with the correct variation as applicable. Verify integrity polling and event classes on known points.',
    ],
  },
  DNP3_SERVER: {
    focus: 'a DNP3 outstation and its exported point map',
    reference: 'dnp3-go/cmd/dnp3server/README.md',
    checks: [
      'Choose connectionMode and set the endpoint for that mode. Set the local outstation and remote master link addresses.',
      'Populate protocolDestinations with the required object families, indexes, variations and event classes. Verify the master’s integrity poll on the intended outstation.',
    ],
  },
  'MQTT-SPARKPLUG-B': {
    focus: 'MQTT broker sessions, Sparkplug B metrics and topic routing',
    checks: [
      'Set the broker URI in endpointURLs, authentication and TLS trust, and a unique clientId. Use multiple broker URLs for redundant brokers.',
      'Confirm Sparkplug group and edge identity or the regular MQTT topic and payload format. Scope topics to the required subscriptions and verify the corresponding tag mapping.',
    ],
  },
  MODBUS: {
    focus: 'a Modbus client connection and register decoding',
    checks: [
      'Set connectionMode and the TCP/TLS device endpoints or serial settings. Confirm each unit ID, polling interval, register area, zero-based offset and word order.',
      'Use the unit ID as the source common address, an area and offset such as hr:4 as the object address, and protocolSourceASDU for value encoding. Verify a known register value.',
    ],
  },
  SUNSPEC: {
    focus: 'SunSpec model discovery and tag mapping over Modbus',
    checks: [
      'Choose the Modbus transport and unitIds. Confirm whether the device exposes holding or input registers. Set baseAddresses if the normal SunSpec marker probes miss the map.',
      'Use a model/point reference with the unit ID as the common address. Check the discovered model occurrence and scale factors against a known reading.',
    ],
  },
  MODBUS_SERVER: {
    focus: 'a Modbus server connection and exported registers',
    checks: [
      'Select the passive network or serial connectionMode, the bind address or serial settings, and any permitted master IPs. Check the unit IDs and unmapped-address behavior.',
      'Map each exported tag through protocolDestinations with the unit ID, area and zero-based register or bit offset, and value encoding. Validate reads from the intended master.',
    ],
  },
  'OPC-UA': {
    focus: 'an OPC UA client session, subscriptions and NodeIds',
    checks: [
      'Set the opc.tcp endpoint in endpointURLs and match security mode, security policy and user identity to an advertised endpoint. Verify the server certificate trust.',
      'Use exact NodeIds for manual tags. With auto-creation enabled, use topics to scope browsing and verify the resulting NodeIds, publishing intervals and quality.',
    ],
  },
  'OPC-UA_SERVER': {
    focus: 'an OPC UA server endpoint and exposed tag groups',
    checks: [
      'Set the port in ipAddressLocalBind and the endpoint resource path in groupId. Check the supported bind address, peer IP allowlist, configured users and secure-channel settings.',
      'Use topics to scope exposed group1 values. Browse with a client and check the intended variables, NodeIds, data types and access rights.',
    ],
  },
  'OPC-DA': {
    focus: 'a Windows OPC DA client and its COM item subscriptions',
    checks: [
      'Verify OPC Classic prerequisites and the Windows service identity. Use opcda://hostname/ServiceName in endpointURLs and confirm remote DCOM access if applicable.',
      'Scope browse discovery with topics and use exact OPC DA item IDs as source object addresses. Verify a known item before expanding the point list.',
    ],
  },
  'OPC-DA_SERVER': {
    focus: 'a Windows OPC DA server, COM registration and exported items',
    checks: [
      'Use a distinct clsIdServer, clsIdApp, and ProgID identity for each running instance. Follow the Windows COM registration procedure and verify the identity from a DA client.',
      'Use topics to scope exported group1 values. Confirm the item IDs from the group hierarchy and ungrouped description, plus types and access rights.',
    ],
  },
  PLCTAG: {
    focus: 'an installed PLCTAG client and its PLC address map',
    checks: [
      'Confirm that a PLCTAG executable is installed and obtain the matching implementation documentation before enabling an instance. The JSON-SCADA catalog supplies the identity and has no bundled reference.',
      'Confirm the PLC endpoint, tag-address grammar, data types and polling behavior against a known point read.',
    ],
  },
  PLC4X: {
    focus: 'the PLC4J client, including endpoint URLs and PLC topic addresses',
    checks: [
      'Use the PLC4X protocol scheme and parameters in endpointURLs for the actual PLC and confirm that the deployed PLC4J build supports it.',
      'Use TAG_NAME|PLC4X_ADDRESS|ENDIANNESS entries in topics. Verify array indexing, data types and byte order against a known PLC value.',
    ],
  },
  'TELEGRAF-LISTENER': {
    focus: 'Telegraf JSON metrics over UDP',
    checks: [
      'Point the Telegraf JSON socket output at the port in ipAddressLocalBind. Check the permitted source addresses in ipAddresses and the UDP listener’s network restrictions.',
      'Verify that one known measurement produces the expected tag and fields. The UDP source IP filter provides no sender authentication.',
    ],
  },
  'NODE-RED': {
    focus: 'Node-RED WebSocket integration and flow tag routing',
    checks: [
      'Set ipAddressLocalBind, the permitted Node-RED peer IPs, and the shared token in password. Match the WebSocket URL in the JSON-SCADA nodes and use TLS for off-host links.',
      'Use topics for the outbound group1 filter. Check the inbound tag ID convention and autoCreateTags before testing an update flow.',
    ],
  },
  N8N: {
    focus: 'n8n webhook delivery and authenticated inbound updates',
    checks: [
      'Configure outbound webhook endpointURLs, topic filters and webhook authentication. For inbound updates, configure the listener and the separate username/password that n8n presents.',
      'Verify webhook delivery and inbound health or updates separately. Direct inbound commands require both commandsEnabled and options.enableDirectCommands.',
    ],
  },
  ICCP: {
    focus: 'an ICCP/TASE.2 client association and remote data objects',
    checks: [
      'Set endpointURLs and agree on local and remote AP titles and AE qualifiers. Verify the site’s ACSE authentication and TLS requirements.',
      'Map tags using the remote Domain/Item references. Check the association and integrity poll against known objects.',
    ],
  },
  ICCP_SERVER: {
    focus: 'an ICCP/TASE.2 server association and bilateral data access',
    checks: [
      'Set ipAddressLocalBind and agree on AP titles, AE qualifiers and TLS with the peer. Configure remoteApTitle and topics for bilateral table access. The IP list reports unexpected peers without rejecting them.',
      'Confirm the intended domains and dataset membership before testing reads or transfer-set reporting from the agreed peer.',
    ],
  },
  I104M: {
    focus: 'a legacy I104M deployment and its listener settings',
    checks: [
      'Verify the legacy binary and matching installation documentation before enabling the connection. The current platform build scripts leave that driver build disabled.',
      'Inspect the deployed ipAddressLocalBind and expected peers. The AdminUI fallback bind port is 8099. Confirm the transport and mapping from the installed driver’s documentation.',
    ],
  },
  PI_DATA_ARCHIVE_INJECTOR: {
    focus: 'an externally deployed PI Data Archive injection integration',
    checks: [
      'Confirm that the injector and its matching documentation are installed. JSON-SCADA does not manage its OS service.',
      'Agree on the PI archive, selected source tags, point names, write permissions and buffering and replay policy. Match topics and queue settings to the installed connector and verify one approved test point.',
    ],
  },
  PI_DATA_ARCHIVE_CLIENT: {
    focus: 'an externally deployed PI Data Archive read integration',
    checks: [
      'Confirm that the client and its matching documentation are installed. JSON-SCADA does not manage its OS service.',
      'Agree on the PI archive, point mappings, read identity, sampling and timestamp conventions. Match the deployed connector’s topics format and check one point’s value and quality.',
    ],
  },
  ONVIF: {
    focus: 'an ONVIF camera or stream and the video proxy',
    checks: [
      'Set the first endpointURLs entry to the ONVIF device-service URL for camera controls and events, or a supported stream URL for video only. Confirm camera credentials and FFmpeg availability.',
      'Assign a distinct WebSocket port in ipAddressLocalBind and match the reverse-proxy route. The driver uses only the port from this field. Verify the stream and any event tags.',
    ],
  },
  'CIM-EMS': {
    focus: 'CIM/CGMES network model connections, telemetry bindings and study cycles',
    checks: [
      'Use the CIM-EMS admin workflow to import, validate and activate the intended model revision. Review binding coverage and check units and directions against the source tags before approving bindings.',
      'Check the connection cycle, telemetry freshness and study settings before starting or updating the instance. Verify topology and load-flow results and any enabled estimation or contingency outputs with the CIM-EMS tools.',
    ],
  },
}

export async function loadDriverSkillFiles(): Promise<Record<string, string | Uint8Array>> {
  const root = srcDir()
  const files: Record<string, string | Uint8Array> = {}

  for (const driver of PROTOCOL_DRIVER_NAMES) {
    const { doc, role } = PROTOCOL_DRIVERS[driver]
    const { focus, checks, reference = doc } = SETUP[driver]
    const name = `configure-${driver.toLowerCase().replaceAll('_', '-')}`
    const description = `Configure ${driver} in JSON-SCADA. Use for ${focus}.`
    let referenceNote = doc
      ? `Call get_protocol_driver_documentation with protocolDriver set to "${driver}" for the installed driver documentation.`
      : 'Use the documentation for the specific driver build installed at the site.'

    if (reference) {
      try {
        files[`${name}/references/driver.md`] = await readFile(path.join(root, reference))
        referenceNote = 'Read [the driver reference](references/driver.md) for the full field and point-address definitions.'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`Could not load the configuration reference for ${driver}:`, error)
        }
      }
    }

    files[`${name}/SKILL.md`] = `---
name: ${name}
description: ${JSON.stringify(description)}
---

# Configure ${driver}

Use the exact protocolDriver value **${driver}** (role: ${role}).

## Driver settings

${checks.map(check => '- ' + check).join('\n')}

${referenceNote}

## Apply and verify

1. Call get_system_status and inspect any existing link with get_protocol_connection using its protocolConnectionNumber. With admin tools available, list_driver_processes shows the instance and OS service state. Check the intended instance, node names, endpoint and point map before making changes.
2. Use the AdminUI driver instance and protocol connection screens or the create_driver_instance, update_driver_instance, create_protocol_connection and update_protocol_connection tools. Apply changes through these interfaces so API validation and auditing run. Pass driver-specific connection fields in settings. Use the connection number assigned by the server for a new link.
3. When manual point mapping is needed, use create_tag or update_tag and follow the driver’s source fields or destination list. Preserve mappings for other connections when editing fields.protocolDestinations. Keep controls disabled on new links unless they are part of the requested deployment.
4. Check the write result for restart status. Where a managed restart is pending, coordinate it for the affected instance. Run diagnose_connection with the connection number and verify data quality or downstream reads using a known point.
`
  }

  return files
}
