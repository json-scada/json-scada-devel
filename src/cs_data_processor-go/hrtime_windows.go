//go:build windows

/*
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

package main

import (
	"syscall"
	"unsafe"
)

var (
	kernel32DLL = syscall.NewLazyDLL("kernel32.dll")
	procQPC     = kernel32DLL.NewProc("QueryPerformanceCounter")
	procQPF     = kernel32DLL.NewProc("QueryPerformanceFrequency")
	qpcFreq     int64
	qpcOrigin   int64
)

func init() {
	var f int64
	procQPF.Call(uintptr(unsafe.Pointer(&f)))
	if f <= 0 {
		f = 1
	}
	qpcFreq = f
	procQPC.Call(uintptr(unsafe.Pointer(&qpcOrigin)))
}

// hrNowNanos reads the performance counter, whose resolution is normally
// 100 ns. The counter is rebased on the process start so the multiplication
// by 1e9 cannot overflow.
func hrNowNanos() int64 {
	var c int64
	procQPC.Call(uintptr(unsafe.Pointer(&c)))
	c -= qpcOrigin
	return (c/qpcFreq)*1e9 + ((c%qpcFreq)*1e9)/qpcFreq
}
