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

    public enum EventState
    {
        INDETERMINATE_0 = 0,
        OFF = 1,
        ON = 2,
        INDETERMINATE_3 = 3
    }


    public class SingleEvent
    {
        private QualityDescriptorP qdp;

        private EventState eventState;

        public SingleEvent()
        {
            eventState = EventState.INDETERMINATE_0;
            qdp = new QualityDescriptorP();
        }

        public SingleEvent(SingleEvent orignal)
        {
            eventState = orignal.eventState;
            qdp = new QualityDescriptorP(orignal.qdp);
        }

        public override bool Equals(object obj)
        {
            if (obj == null)
                return false;

            if (!(obj is SingleEvent))
                return false;

            return (EncodedValue == ((SingleEvent)obj).EncodedValue);
        }

        public override int GetHashCode()
        {
            return EncodedValue.GetHashCode();
        }

        public SingleEvent(byte encodedValue)
        {
            eventState = (EventState)(encodedValue & 0x03);

            qdp = new QualityDescriptorP(encodedValue);
        }

        public EventState State
        {
            get
            {
                return eventState;
            }
            set
            {
                eventState = value;
            }
        }

        public QualityDescriptorP QDP
        {
            get
            {
                return qdp;
            }
            set
            {
                qdp = value;
            }
        }

        public byte EncodedValue
        {
            get
            {
                byte encodedValue = (byte)((qdp.EncodedValue & 0xfc) + (int)eventState);

                return encodedValue;
            }
        }

    }
}

