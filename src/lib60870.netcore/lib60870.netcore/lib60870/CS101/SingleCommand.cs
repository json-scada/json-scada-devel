/*
 *  Copyright 2016-2025 Michael Zillgith
 *
 *  This file is part of lib60870.NET
 *
 *  lib60870.NET is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  lib60870.NET is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with lib60870.NET.  If not, see <http://www.gnu.org/licenses/>.
 *
 *  See COPYING file for the complete license text.
 */

namespace lib60870.CS101
{

    /// <summary>
    /// Regulating step command state (RCS) according to IEC 60870-5-101:2003 7.2.6.17
    /// </summary>
    public enum StepCommandValue
    {
        INVALID_0 = 0,
        LOWER = 1,
        HIGHER = 2,
        INVALID_3 = 3
    }


    public class SingleCommand : InformationObject
    {
        override public int GetEncodedSize()
        {
            return 1;
        }

        override public TypeID Type
        {
            get
            {
                return TypeID.C_SC_NA_1;
            }
        }

        override public bool SupportsSequence
        {
            get
            {
                return false;
            }
        }

        private byte sco;

        public SingleCommand(int ioa, bool command, bool selectCommand, int qu)
            : base(ioa)
        {
            sco = (byte)((qu & 0x1f) * 4);

            if (command)
                sco |= 0x01;

            if (selectCommand)
                sco |= 0x80;
        }

        public SingleCommand(SingleCommand original)
            : base(original.ObjectAddress)
        {
            sco = original.sco;
        }

        internal SingleCommand(ApplicationLayerParameters parameters, byte[] msg, int startIndex)
            : base(parameters, msg, startIndex, false)
        {
            startIndex += parameters.SizeOfIOA; /* skip IOA */

            if ((msg.Length - startIndex) < GetEncodedSize())
                throw new ASDUParsingException("Message too small");

            sco = msg[startIndex++];
        }

        public override void Encode(Frame frame, ApplicationLayerParameters parameters, bool isSequence)
        {
            base.Encode(frame, parameters, isSequence);

            frame.SetNextByte(sco);
        }

        public int QU
        {
            get
            {
                return ((sco & 0x7c) / 4);
            }
            set
            {
                sco = (byte)(sco & 0x81);
                sco += (byte)((value & 0x1f) * 4);
            }
        }

        /// <summary>
        /// Gets the state (off - false / on - true) of this command
        /// </summary>
        /// <value><c>true</c> if on; otherwise, <c>false</c>.</value>
        public bool State
        {
            get
            {
                return ((sco & 0x01) == 0x01);
            }
            set
            {
                if (value)
                    sco |= 0x01;
                else
                    sco &= 0xfe;
            }
        }

        /// <summary>
        /// Indicates if the command is a select or an execute command
        /// </summary>
        /// <value><c>true</c> if select; execute, <c>false</c>.</value>
        public bool Select
        {
            get
            {
                return ((sco & 0x80) == 0x80);
            }
            set
            {
                if (value)
                    sco |= 0x80;
                else
                    sco &= 0x7f;
            }
        }

        public override string ToString()
        {
            return string.Format("[SingleCommand: QU={0}, State={1}, Select={2}]", QU, State, Select);
        }

    }

    public class SingleCommandWithCP56Time2a : SingleCommand
    {
        override public TypeID Type
        {
            get
            {
                return TypeID.C_SC_TA_1;
            }
        }

        override public bool SupportsSequence
        {
            get
            {
                return false;
            }
        }

        private CP56Time2a timestamp;

        public CP56Time2a Timestamp
        {
            get
            {
                return timestamp;
            }
        }

        public SingleCommandWithCP56Time2a(int ioa, bool command, bool selectCommand, int qu, CP56Time2a timestamp)
            : base(ioa, command, selectCommand, qu)
        {
            this.timestamp = timestamp;
        }

        public SingleCommandWithCP56Time2a(SingleCommandWithCP56Time2a original)
            : base(original)
        {
            timestamp = new CP56Time2a(original.timestamp);
        }

        internal SingleCommandWithCP56Time2a(ApplicationLayerParameters parameters, byte[] msg, int startIndex)
            : base(parameters, msg, startIndex)
        {
            startIndex += parameters.SizeOfIOA; /* skip IOA */

            if ((msg.Length - startIndex) < GetEncodedSize())
                throw new ASDUParsingException("Message too small");

            startIndex += 1; /* SCO */

            timestamp = new CP56Time2a(msg, startIndex);
        }

        public override void Encode(Frame frame, ApplicationLayerParameters parameters, bool isSequence)
        {
            base.Encode(frame, parameters, isSequence);

            frame.AppendBytes(timestamp.GetEncodedValue());
        }
    }

    public class DoubleCommand : InformationObject
    {
        override public int GetEncodedSize()
        {
            return 1;
        }

        override public TypeID Type
        {
            get
            {
                return TypeID.C_DC_NA_1;
            }
        }

        override public bool SupportsSequence
        {
            get
            {
                return false;
            }
        }

        public static int OFF = 1;
        public static int ON = 2;

        private byte dcq;

        public DoubleCommand(int ioa, int command, bool select, int quality)
            : base(ioa)
        {
            dcq = (byte)(command & 0x03);
            dcq += (byte)((quality & 0x1f) * 4);

            if (select)
                dcq |= 0x80;
        }

        public DoubleCommand(DoubleCommand original)
            : base(original.ObjectAddress)
        {
            dcq = original.dcq;
        }

        internal DoubleCommand(ApplicationLayerParameters parameters, byte[] msg, int startIndex)
            : base(parameters, msg, startIndex, false)
        {
            startIndex += parameters.SizeOfIOA; /* skip IOA */

            if ((msg.Length - startIndex) < GetEncodedSize())
                throw new ASDUParsingException("Message too small");

            dcq = msg[startIndex++];
        }

        public override void Encode(Frame frame, ApplicationLayerParameters parameters, bool isSequence)
        {
            base.Encode(frame, parameters, isSequence);

            frame.SetNextByte(dcq);
        }

        public int QU
        {
            get
            {
                return ((dcq & 0x7c) / 4);
            }
        }

        public int State
        {
            get
            {
                return (dcq & 0x03);
            }
        }

        public bool Select
        {
            get
            {
                return ((dcq & 0x80) == 0x80);
            }
        }
    }

    public class DoubleCommandWithCP56Time2a : DoubleCommand
    {
        override public TypeID Type
        {
            get
            {
                return TypeID.C_DC_TA_1;
            }
        }

        override public bool SupportsSequence
        {
            get
            {
                return false;
            }
        }

        public CP56Time2a Timestamp
        {
            get
            {
                return timestamp;
            }
        }

        private CP56Time2a timestamp;

        public DoubleCommandWithCP56Time2a(int ioa, int command, bool select, int quality, CP56Time2a timestamp)
            : base(ioa, command, select, quality)
        {
            this.timestamp = timestamp;
        }

        public DoubleCommandWithCP56Time2a(DoubleCommandWithCP56Time2a original)
            : base(original)
        {
            timestamp = new CP56Time2a(original.timestamp);
        }

        internal DoubleCommandWithCP56Time2a(ApplicationLayerParameters parameters, byte[] msg, int startIndex)
            : base(parameters, msg, startIndex)
        {
            startIndex += parameters.SizeOfIOA; /* skip IOA */

            if ((msg.Length - startIndex) < GetEncodedSize())
                throw new ASDUParsingException("Message too small");

            startIndex += 1; /* DCQ */

            timestamp = new CP56Time2a(msg, startIndex);
        }

        public override void Encode(Frame frame, ApplicationLayerParameters parameters, bool isSequence)
        {
            base.Encode(frame, parameters, isSequence);

            frame.AppendBytes(timestamp.GetEncodedValue());
        }

    }

    public class StepCommand : DoubleCommand
    {
        override public TypeID Type
        {
            get
            {
                return TypeID.C_RC_NA_1;
            }
        }

        override public bool SupportsSequence
        {
            get
            {
                return false;
            }
        }

        public StepCommand(int ioa, StepCommandValue command, bool select, int quality)
            : base(ioa, (int)command, select, quality)
        {
        }

        public StepCommand(StepCommand original)
            : base(original)
        {
        }

        internal StepCommand(ApplicationLayerParameters parameters, byte[] msg, int startIndex)
            : base(parameters, msg, startIndex)
        {
        }

        public new StepCommandValue State
        {
            get
            {
                return (StepCommandValue)(base.State);
            }
        }
    }

    public class StepCommandWithCP56Time2a : StepCommand
    {
        override public TypeID Type
        {
            get
            {
                return TypeID.C_RC_TA_1;
            }
        }

        override public bool SupportsSequence
        {
            get
            {
                return false;
            }
        }

        private CP56Time2a timestamp;

        public CP56Time2a Timestamp
        {
            get
            {
                return timestamp;
            }
        }

        public StepCommandWithCP56Time2a(int ioa, StepCommandValue command, bool select, int quality, CP56Time2a timestamp)
            : base(ioa, command, select, quality)
        {
            this.timestamp = timestamp;
        }

        public StepCommandWithCP56Time2a(StepCommandWithCP56Time2a original)
            : base(original)
        {
            timestamp = new CP56Time2a(original.timestamp);
        }

        internal StepCommandWithCP56Time2a(ApplicationLayerParameters parameters, byte[] msg, int startIndex)
            : base(parameters, msg, startIndex)
        {
            startIndex += parameters.SizeOfIOA; /* skip IOA */

            if ((msg.Length - startIndex) < GetEncodedSize())
                throw new ASDUParsingException("Message too small");

            startIndex += 1; /* step command value */

            timestamp = new CP56Time2a(msg, startIndex);
        }

        public override void Encode(Frame frame, ApplicationLayerParameters parameters, bool isSequence)
        {
            base.Encode(frame, parameters, isSequence);

            frame.AppendBytes(timestamp.GetEncodedValue());
        }

    }



}

