/*
 *  MeasuredValueNormalized.cs
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
    /// <summary>
    /// Measured value normalized without quality information object (M_ME_ND_1)
    /// </summary>
    public class MeasuredValueNormalizedWithoutQuality : InformationObject
    {
        override public int GetEncodedSize()
        {
            return 2;
        }

        override public TypeID Type
        {
            get
            {
                return TypeID.M_ME_ND_1;
            }
        }

        override public bool SupportsSequence
        {
            get
            {
                return false;
            }
        }

        private ScaledValue scaledValue;

        public short RawValue
        {
            get
            {
                return scaledValue.ShortValue;
            }
            set
            {
                scaledValue.ShortValue = value;
            }
        }

        public float NormalizedValue
        {
            get
            {
                return scaledValue.GetNormalizedValue();
            }
            set
            {
                scaledValue.SetScaledFromNormalizedValue(value);
            }
        }

        public MeasuredValueNormalizedWithoutQuality(int objectAddress, float normalizedValue)
            : base(objectAddress)
        {
            scaledValue = new ScaledValue();
            NormalizedValue = normalizedValue;
        }

        public MeasuredValueNormalizedWithoutQuality(MeasuredValueNormalizedWithoutQuality original)
            : base(original.ObjectAddress)
        {
            scaledValue = new ScaledValue(original.scaledValue);
        }

        public MeasuredValueNormalizedWithoutQuality(int objectAddress, short rawValue)
            : base(objectAddress)
        {
            scaledValue = new ScaledValue(rawValue);
        }

        internal MeasuredValueNormalizedWithoutQuality(ApplicationLayerParameters parameters, byte[] msg, int startIndex, bool isSequence)
            : base(parameters, msg, startIndex, isSequence)
        {
            if (!isSequence)
                startIndex += parameters.SizeOfIOA; /* skip IOA */

            if ((msg.Length - startIndex) < GetEncodedSize())
                throw new ASDUParsingException("Message too small");

            scaledValue = new ScaledValue(msg, startIndex);
        }

        public override void Encode(Frame frame, ApplicationLayerParameters parameters, bool isSequence)
        {
            base.Encode(frame, parameters, isSequence);

            frame.AppendBytes(scaledValue.GetEncodedValue());
        }
    }

    /// <summary>
    /// Measured value normalized information object (M_ME_NA_1)
    /// </summary>
    public class MeasuredValueNormalized : MeasuredValueNormalizedWithoutQuality
    {
        override public int GetEncodedSize()
        {
            return 3;
        }

        override public TypeID Type
        {
            get
            {
                return TypeID.M_ME_NA_1;
            }
        }

        override public bool SupportsSequence
        {
            get
            {
                return true;
            }
        }

        private QualityDescriptor quality;

        public QualityDescriptor Quality
        {
            get
            {
                return quality;
            }
        }

        public MeasuredValueNormalized(int objectAddress, float value, QualityDescriptor quality)
            : base(objectAddress, value)
        {
            this.quality = quality;
        }

        public MeasuredValueNormalized(int objectAddress, short value, QualityDescriptor quality)
            : base(objectAddress, value)
        {
            this.quality = quality;
        }

        public MeasuredValueNormalized(MeasuredValueNormalized original)
            : base(original)
        {
            quality = new QualityDescriptor(original.quality);
        }

        internal MeasuredValueNormalized(ApplicationLayerParameters parameters, byte[] msg, int startIndex, bool isSequence)
            : base(parameters, msg, startIndex, isSequence)
        {
            if (!isSequence)
                startIndex += parameters.SizeOfIOA; /* skip IOA */

            if ((msg.Length - startIndex) < GetEncodedSize())
                throw new ASDUParsingException("Message too small");

            startIndex += 2; /* normalized value */

            /* parse QDS (quality) */
            quality = new QualityDescriptor(msg[startIndex++]);
        }

        public override void Encode(Frame frame, ApplicationLayerParameters parameters, bool isSequence)
        {
            base.Encode(frame, parameters, isSequence);

            frame.SetNextByte(quality.EncodedValue);
        }
    }

    /// <summary>
    /// Measured value normalized with CP24Time2a time tag (M_ME_TA_1)
    /// </summary>
    public class MeasuredValueNormalizedWithCP24Time2a : MeasuredValueNormalized
    {
        override public int GetEncodedSize()
        {
            return 6;
        }

        override public TypeID Type
        {
            get
            {
                return TypeID.M_ME_TA_1;
            }
        }

        override public bool SupportsSequence
        {
            get
            {
                return false;
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


        public MeasuredValueNormalizedWithCP24Time2a(int objectAddress, float value, QualityDescriptor quality, CP24Time2a timestamp)
            : base(objectAddress, value, quality)
        {
            this.timestamp = timestamp;
        }

        public MeasuredValueNormalizedWithCP24Time2a(int objectAddress, short value, QualityDescriptor quality, CP24Time2a timestamp)
            : base(objectAddress, value, quality)
        {
            this.timestamp = timestamp;
        }

        public MeasuredValueNormalizedWithCP24Time2a(MeasuredValueNormalizedWithCP24Time2a original)
            : base(original)
        {
            timestamp = new CP24Time2a(original.timestamp);
        }

        internal MeasuredValueNormalizedWithCP24Time2a(ApplicationLayerParameters parameters, byte[] msg, int startIndex, bool isSequence)
            : base(parameters, msg, startIndex, isSequence)
        {
            if (!isSequence)
                startIndex += parameters.SizeOfIOA; /* skip IOA */

            if ((msg.Length - startIndex) < GetEncodedSize())
                throw new ASDUParsingException("Message too small");

            startIndex += 3; /* normalized value + quality */

            /* parse CP24Time2a (time stamp) */
            timestamp = new CP24Time2a(msg, startIndex);
        }

        public override void Encode(Frame frame, ApplicationLayerParameters parameters, bool isSequence)
        {
            base.Encode(frame, parameters, isSequence);

            frame.AppendBytes(timestamp.GetEncodedValue());
        }
    }

    /// <summary>
    /// Measured value normalized with CP56Time2a time tag (M_ME_TD_1)
    /// </summary>
    public class MeasuredValueNormalizedWithCP56Time2a : MeasuredValueNormalized
    {
        override public int GetEncodedSize()
        {
            return 10;
        }

        override public TypeID Type
        {
            get
            {
                return TypeID.M_ME_TD_1;
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

        public MeasuredValueNormalizedWithCP56Time2a(int objectAddress, float value, QualityDescriptor quality, CP56Time2a timestamp)
            : base(objectAddress, value, quality)
        {
            this.timestamp = timestamp;
        }

        public MeasuredValueNormalizedWithCP56Time2a(int objectAddress, short value, QualityDescriptor quality, CP56Time2a timestamp)
            : base(objectAddress, value, quality)
        {
            this.timestamp = timestamp;
        }

        public MeasuredValueNormalizedWithCP56Time2a(MeasuredValueNormalizedWithCP56Time2a original)
            : base(original)
        {
            timestamp = new CP56Time2a(original.timestamp);
        }

        internal MeasuredValueNormalizedWithCP56Time2a(ApplicationLayerParameters parameters, byte[] msg, int startIndex, bool isSequence)
            : base(parameters, msg, startIndex, isSequence)
        {
            if (!isSequence)
                startIndex += parameters.SizeOfIOA; /* skip IOA */

            if ((msg.Length - startIndex) < GetEncodedSize())
                throw new ASDUParsingException("Message too small");

            startIndex += 3; /* normalized value + quality */

            /* parse CP56Time2a (time stamp) */
            timestamp = new CP56Time2a(msg, startIndex);
        }

        public override void Encode(Frame frame, ApplicationLayerParameters parameters, bool isSequence)
        {
            base.Encode(frame, parameters, isSequence);

            frame.AppendBytes(timestamp.GetEncodedValue());
        }
    }

}

