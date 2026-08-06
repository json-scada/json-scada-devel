/*
 * IEC 61850 MMS Server driver (IEC61850-90-2 gateway) for {json:scada}, in Go.
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

// TLS configuration for secured MMS associations (IEC 62351-3), built from
// the same connection parameters the C# driver passes to libiec61850.

package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"strings"
)

// buildTLS assembles the server TLS configuration of a connection.
func buildTLS(conn *ServerConnection) (*tls.Config, error) {
	cfg := &tls.Config{}

	if conn.LocalCertFilePath == "" || conn.PrivateKeyFilePath == "" {
		return nil, fmt.Errorf("useSecurity requires localCertFilePath and privateKeyFilePath")
	}
	cert, err := tls.LoadX509KeyPair(conn.LocalCertFilePath, conn.PrivateKeyFilePath)
	if err != nil {
		return nil, fmt.Errorf("own certificate: %w", err)
	}
	cfg.Certificates = []tls.Certificate{cert}

	if conn.RootCertFilePath != "" {
		ca, err := loadCert(conn.RootCertFilePath)
		if err != nil {
			return nil, fmt.Errorf("CA certificate: %w", err)
		}
		pool := x509.NewCertPool()
		pool.AddCert(ca)
		cfg.ClientCAs = pool
	}

	var pinned []*x509.Certificate
	if conn.AllowOnlySpecificCertificates {
		for _, path := range conn.PeerCertFilesPaths {
			if strings.TrimSpace(path) == "" {
				continue
			}
			c, err := loadCert(path)
			if err != nil {
				return nil, fmt.Errorf("peer certificate %s: %w", path, err)
			}
			pinned = append(pinned, c)
		}
	}

	if conn.ChainValidation || len(pinned) > 0 {
		// Ask for a client certificate and check it ourselves, so pinning
		// and chain validation can be combined the way the connection asks.
		cfg.ClientAuth = tls.RequireAnyClientCert
		chainValidation := conn.ChainValidation
		roots := cfg.ClientCAs
		cfg.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return fmt.Errorf("no client certificate presented")
			}
			if len(pinned) > 0 {
				ok := false
				for _, p := range pinned {
					if bytes.Equal(p.Raw, rawCerts[0]) {
						ok = true
						break
					}
				}
				if !ok {
					return fmt.Errorf("client certificate is not in the allowed list")
				}
			}
			if chainValidation {
				leaf, err := x509.ParseCertificate(rawCerts[0])
				if err != nil {
					return err
				}
				inter := x509.NewCertPool()
				for _, raw := range rawCerts[1:] {
					if c, err := x509.ParseCertificate(raw); err == nil {
						inter.AddCert(c)
					}
				}
				if _, err := leaf.Verify(x509.VerifyOptions{
					Roots:         roots,
					Intermediates: inter,
					KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
				}); err != nil {
					return err
				}
			}
			return nil
		}
	}

	minV, maxV := tlsVersionWindow(conn)
	cfg.MinVersion, cfg.MaxVersion = minV, maxV
	Log(LogLevelBasic, "TLS enabled (IEC 62351-3), versions %s..%s", tlsVersionName(minV), tlsVersionName(maxV))
	if (conn.AllowTLSv10 || conn.AllowTLSv11) && minV >= tls.VersionTLS12 {
		Log(LogLevelBasic, "TLS 1.0/1.1 requested but not available in this build; minimum is %s",
			tlsVersionName(minV))
	}

	if suites := parseCipherList(conn.CipherList); len(suites) > 0 {
		cfg.CipherSuites = suites
	}
	return cfg, nil
}

// tlsVersionWindow resolves the enabled versions to a min/max window: the
// lowest and the highest enabled. The C# cascade could produce a minimum
// above its maximum for some flag combinations.
func tlsVersionWindow(conn *ServerConnection) (uint16, uint16) {
	var versions []uint16
	if conn.AllowTLSv10 {
		versions = append(versions, tls.VersionTLS10)
	}
	if conn.AllowTLSv11 {
		versions = append(versions, tls.VersionTLS11)
	}
	if conn.AllowTLSv12 {
		versions = append(versions, tls.VersionTLS12)
	}
	if conn.AllowTLSv13 {
		versions = append(versions, tls.VersionTLS13)
	}
	if len(versions) == 0 {
		return tls.VersionTLS12, tls.VersionTLS13
	}
	minV, maxV := versions[0], versions[len(versions)-1]
	if minV < tls.VersionTLS12 && maxV >= tls.VersionTLS12 {
		minV = tls.VersionTLS12
	}
	return minV, maxV
}

func tlsVersionName(v uint16) string {
	switch v {
	case tls.VersionTLS10:
		return "TLS1.0"
	case tls.VersionTLS11:
		return "TLS1.1"
	case tls.VersionTLS12:
		return "TLS1.2"
	case tls.VersionTLS13:
		return "TLS1.3"
	}
	return "?"
}

// loadCert reads a PEM or DER encoded certificate.
func loadCert(path string) (*x509.Certificate, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if block, _ := pem.Decode(data); block != nil {
		return x509.ParseCertificate(block.Bytes)
	}
	return x509.ParseCertificate(data)
}

// parseCipherList maps IANA cipher suite names to their identifiers.
// Unknown names are ignored with a log line. TLS 1.3 suites are fixed by
// the standard and cannot be selected here.
func parseCipherList(list string) []uint16 {
	list = strings.TrimSpace(list)
	if list == "" {
		return nil
	}
	byName := map[string]uint16{}
	for _, s := range tls.CipherSuites() {
		byName[strings.ToUpper(s.Name)] = s.ID
	}
	for _, s := range tls.InsecureCipherSuites() {
		byName[strings.ToUpper(s.Name)] = s.ID
	}
	var out []uint16
	for _, name := range strings.FieldsFunc(list, func(r rune) bool { return r == ',' || r == ':' || r == ' ' }) {
		key := strings.ToUpper(strings.TrimSpace(name))
		if id, ok := byName[key]; ok {
			out = append(out, id)
		} else {
			Log(LogLevelBasic, "Unknown cipher suite in cipherList: %s", name)
		}
	}
	return out
}
