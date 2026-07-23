/*
 * PLCTags CIP Ethernet/IP & Modbus TCP Client Protocol driver for {json:scada}
 * {json:scada} - Copyright (c) 2020 - 2026 - Ricardo L. Olsen
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

using libplctag;
using System;
using System.Diagnostics;
using System.Threading;

namespace PLCTagDriver
{
    partial class MainClass
    {
        static double GetTagElementValue(ScanTag st, int index)
        {
            switch (st.Type)
            {
                case PlcDataType.Bool:
                    // a single BOOL is held in a byte, BOOL arrays are bit-packed
                    if (st.IsArray)
                        return st.Tag.GetBit(index) ? 1 : 0;
                    return st.Tag.GetUInt8(0) != 0 ? 1 : 0;
                case PlcDataType.Sint:
                    return st.Tag.GetInt8(index);
                default:
                case PlcDataType.Int:
                    return st.Tag.GetInt16(2 * index);
                case PlcDataType.Dint:
                    return st.Tag.GetInt32(4 * index);
                case PlcDataType.Lint:
                    return st.Tag.GetInt64(8 * index);
                case PlcDataType.Real:
                    return st.Tag.GetFloat32(4 * index);
                case PlcDataType.Lreal:
                    return st.Tag.GetFloat64(8 * index);
            }
        }

        static void ProcessPLCScan(PLC_connection srv)
        {
            for (; ; )
            {
                try
                {
                    if (!Active)
                    {
                        Thread.Sleep(1000);
                        continue;
                    }

                    var asyncStopWatch = Stopwatch.StartNew();

                    foreach (var st in srv.listTags)
                    {
                        try
                        {
                            st.Tag.Read();
                            var status = st.Tag.GetStatus();
                            if (status != Status.Ok)
                            {
                                Log(srv.name + " - " + st.Tag.Name + " - Error status: " + status);
                                continue;
                            }

                            var count = st.IsArray ? st.ArrayLength : 1;
                            for (var i = 0; i < count; i++)
                            {
                                PLC_Value iv =
                                new PLC_Value()
                                {
                                    conn_number = srv.protocolConnectionNumber,
                                    address = st.IsArray ? st.Tag.Name + "[" + i + "]" : st.Tag.Name,
                                    common_address = st.Tag.Path,
                                    asdu = st.TypeName,
                                    value = GetTagElementValue(st, i),
                                    time_tag = DateTime.Now,
                                    cot = 20
                                };
                                PLCDataQueue.Enqueue(iv);
                                Log(srv.name + " - " + iv.address + " " + iv.asdu + " " + iv.value, LogLevelDetailed);
                            }
                        }
                        catch (LibPlcTagException e)
                        {
                            Log(srv.name + " - Error scanning tag: " + st.Tag.Name + " - Status: " + e.Status);
                        }
                        catch (Exception e)
                        {
                            Log(srv.name + " - Error scanning tag: " + st.Tag.Name);
                            Log(e, LogLevelDetailed);
                        }
                    }

                    asyncStopWatch.Stop();
                    Log($"{srv.name} - Connection scan took {(float)asyncStopWatch.ElapsedMilliseconds} ms.", LogLevelDetailed);

                    Log($"{srv.name} - Sleep {(float)srv.giInterval} ms...", LogLevelDetailed);
                    Thread.Sleep(srv.giInterval);
                }
                catch (Exception e)
                {
                    Log(srv.name + " - Error scanning!");
                    Log(e);
                }
            }
        }
    }
}
