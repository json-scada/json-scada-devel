/*
 *  PackedStartEventsOfProtectionEquipment.cs
 *
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

    public class PackedStartEventsOfProtectionEquipment : InformationObject
    {
        override public int GetEncodedSize()
        {
            return 7;
        }

        override public TypeID Type
        {
            get
            {
                return TypeID.M_EP_TB_1;
            }
        }

        override public bool SupportsSequence
        {
            get
            {
                return true;
            }
        }

        private StartEvent spe;

        public StartEvent SPE
        {
            get
            {
                return spe;
            }
        }

        private QualityDescriptorP qdp;

        public QualityDescriptorP QDP
        {
            get
            {
                return qdp;
            }
        }

        private CP16Time2a elapsedTime;

        public CP16Time2a ElapsedTime
        {
            get
            {
                return elapsedTime;
            }
        }

        private CP24Time2a timestamp;

        public CP24Time2a Timestamp
        {
            get
            {
                return timestamp;
            }
        }

        public PackedStartEventsOfProtectionEquipment(int objectAddress, StartEvent spe, QualityDescriptorP qdp, CP16Time2a elapsedTime, CP24Time2a timestamp)
            : base(objectAddress)
        {
            this.spe = spe;
            this.qdp = qdp;
            this.elapsedTime = elapsedTime;
            this.timestamp = timestamp;
        }

        public PackedStartEventsOfProtectionEquipment(PackedStartEventsOfProtectionEquipment original)
            : base(original.ObjectAddress)
        {
            spe = new StartEvent(original.spe);
            qdp = new QualityDescriptorP(original.qdp);
            elapsedTime = new CP16Time2a(original.elapsedTime);
            timestamp = new CP24Time2a(original.timestamp);
        }

        internal PackedStartEventsOfProtectionEquipment(ApplicationLayerParameters parameters, byte[] msg, int startIndex, bool isSequence)
            : base(parameters, msg, startIndex, isSequence)
        {
            if (!isSequence)
                startIndex += parameters.SizeOfIOA; /* skip IOA */

            if ((msg.Length - startIndex) < GetEncodedSize())
                throw new ASDUParsingException("Message too small");

            spe = new StartEvent(msg[startIndex++]);
            qdp = new QualityDescriptorP(msg[startIndex++]);

            elapsedTime = new CP16Time2a(msg, startIndex);
            startIndex += 2;

            /* parse CP56Time2a (time stamp) */
            timestamp = new CP24Time2a(msg, startIndex);
        }

        public override void Encode(Frame frame, ApplicationLayerParameters parameters, bool isSequence)
        {
            base.Encode(frame, parameters, isSequence);

            frame.SetNextByte(spe.EncodedValue);

            frame.SetNextByte(qdp.EncodedValue);

            frame.AppendBytes(elapsedTime.GetEncodedValue());

            frame.AppendBytes(timestamp.GetEncodedValue());
        }
    }

    public class PackedStartEventsOfProtectionEquipmentWithCP56Time2a : InformationObject
    {
        override public int GetEncodedSize()
        {
            return 11;
        }

        override public TypeID Type
        {
            get
            {
                return TypeID.M_EP_TE_1;
            }
        }

        override public bool SupportsSequence
        {
            get
            {
                return true;
            }
        }

        private StartEvent spe;

        public StartEvent SPE
        {
            get
            {
                return spe;
            }
        }

        private QualityDescriptorP qdp;

        public QualityDescriptorP QDP
        {
            get
            {
                return qdp;
            }
        }

        private CP16Time2a elapsedTime;

        public CP16Time2a ElapsedTime
        {
            get
            {
                return elapsedTime;
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

        public PackedStartEventsOfProtectionEquipmentWithCP56Time2a(int objectAddress, StartEvent spe, QualityDescriptorP qdp, CP16Time2a elapsedTime, CP56Time2a timestamp)
            : base(objectAddress)
        {
            this.spe = spe;
            this.qdp = qdp;
            this.elapsedTime = elapsedTime;
            this.timestamp = timestamp;
        }

        public PackedStartEventsOfProtectionEquipmentWithCP56Time2a(PackedStartEventsOfProtectionEquipmentWithCP56Time2a original)
            : base(original.ObjectAddress)
        {
            spe = new StartEvent(original.spe);
            qdp = new QualityDescriptorP(original.qdp);
            elapsedTime = new CP16Time2a(original.elapsedTime);
            timestamp = new CP56Time2a(original.timestamp);
        }

        internal PackedStartEventsOfProtectionEquipmentWithCP56Time2a(ApplicationLayerParameters parameters, byte[] msg, int startIndex, bool isSequence)
            : base(parameters, msg, startIndex, isSequence)
        {
            if (!isSequence)
                startIndex += parameters.SizeOfIOA; /* skip IOA */

            if ((msg.Length - startIndex) < GetEncodedSize())
                throw new ASDUParsingException("Message too small");

            spe = new StartEvent(msg[startIndex++]);
            qdp = new QualityDescriptorP(msg[startIndex++]);

            elapsedTime = new CP16Time2a(msg, startIndex);
            startIndex += 2;

            /* parse CP56Time2a (time stamp) */
            timestamp = new CP56Time2a(msg, startIndex);
        }

        public override void Encode(Frame frame, ApplicationLayerParameters parameters, bool isSequence)
        {
            base.Encode(frame, parameters, isSequence);

            frame.SetNextByte(spe.EncodedValue);

            frame.SetNextByte(qdp.EncodedValue);

            frame.AppendBytes(elapsedTime.GetEncodedValue());

            frame.AppendBytes(timestamp.GetEncodedValue());
        }
    }
}

