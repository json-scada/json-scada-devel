
/*
 * DNP3 Client Protocol driver for {json:scada}
 * {json:scada} - Copyright (c) 2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 */

#include "../Dnp3Server/json.hpp"

#include <opendnp3/ConsoleLogger.h>
#include <opendnp3/DNP3Manager.h>
#include <opendnp3/channel/PrintingChannelListener.h>
#include <opendnp3/logging/LogLevels.h>
#include <opendnp3/master/DefaultMasterApplication.h>
#include <opendnp3/master/IMasterApplication.h>
#include <opendnp3/master/ISOEHandler.h>
#include <opendnp3/master/MasterStackConfig.h>
#include <opendnp3/master/IMaster.h>
#include <opendnp3/master/ICommandTaskResult.h>
#include <opendnp3/master/ITaskCallback.h>
#include <opendnp3/gen/TaskCompletion.h>
#include <opendnp3/gen/MasterTaskType.h>
#include <opendnp3/app/ControlRelayOutputBlock.h>
#include <opendnp3/app/IINField.h>
#include <opendnp3/app/MeasurementTypes.h>
#include <opendnp3/app/OctetString.h>
#include <opendnp3/app/BinaryCommandEvent.h>
#include <opendnp3/app/AnalogCommandEvent.h>

#include <bsoncxx/builder/basic/document.hpp>
#include <mongocxx/client.hpp>
#include <mongocxx/instance.hpp>
#include <mongocxx/pipeline.hpp>
#include <mongocxx/model/update_one.hpp>
#include <mongocxx/model/write.hpp>
#include <mongocxx/uri.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace std;
using namespace opendnp3;
using bsoncxx::builder::basic::kvp;
using bsoncxx::builder::basic::make_document;
using json = nlohmann::json;

namespace
{
const string DriverMessage = "{json:scada} DNP3 Client Driver (C++)";
const string ProtocolDriverName = "DNP3";
const string DriverVersion = "0.1.2";
const string JsonConfigFilePath = "../conf/json-scada.json";
const string JsonConfigFilePathAlt = "~/json-scada/conf/json-scada.json";
const string ProtocolConnectionsCollectionName = "protocolConnections";
const string ProtocolDriverInstancesCollectionName = "protocolDriverInstances";
const string RealtimeDataCollectionName = "realtimeData";
const string CommandsQueueCollectionName = "commandsQueue";
constexpr uint32_t CROB_PulseOnTime = 100;
constexpr uint32_t CROB_PulseOffTime = 100;
constexpr size_t DataBufferLimit = 10000;

class Logger
{
public:
    enum class Level
    {
        NoLog = 0,
        Basic = 1,
        Detailed = 2,
        Debug = 3
    };

    void setLevel(int value) { level = static_cast<Level>(value); }
    Level getLevel() const { return level; }

    void log(const string& msg, Level msgLevel = Level::Basic) const
    {
        if (msgLevel > level)
            return;
        lock_guard<mutex> guard(mtx);
        auto now = chrono::system_clock::now();
        auto tt = chrono::system_clock::to_time_t(now);
        auto tm = *localtime(&tt);
        auto ms = chrono::duration_cast<chrono::milliseconds>(now.time_since_epoch()) % 1000;
        cout << "[" << put_time(&tm, "%Y-%m-%dT%H:%M:%S") << "." << setw(3) << setfill('0') << ms.count() << "] " << msg
             << endl;
    }

private:
    mutable mutex mtx;
    Level level = Level::Basic;
};

Logger Log;
mongocxx::instance MongoInstance{};

struct JSONSCADAConfig
{
    string nodeName;
    string mongoConnectionString;
    string mongoDatabaseName;
};

struct RangeScan
{
    int group = 1;
    int variation = 1;
    int startAddress = 0;
    int stopAddress = 0;
    int period = 0;
};

struct Dnp3Value
{
    int address = 0;
    int baseGroup = 0;
    int group = 0;
    int variation = 0;
    double value = 0.0;
    string valueString;
    int cot = 20;
    int64_t serverTimestamp = 0;
    bool hasSourceTimestamp = false;
    int64_t sourceTimestamp = 0;
    bool timeTagOk = false;
    bool qOnline = true;
    bool qCommLost = false;
    bool qRemoteForced = false;
    bool qLocalForced = false;
    bool qOverrange = false;
    bool qRollover = false;
    bool qReferenceError = false;
    bool qTransient = false;
    int connNumber = 0;
};

struct DNP3Connection
{
    int protocolDriverInstanceNumber = 1;
    int protocolConnectionNumber = 1;
    string name = "NO NAME";
    bool enabled = true;
    bool commandsEnabled = true;
    string connectionMode = "TCP ACTIVE";
    string ipAddressLocalBind;
    vector<string> ipAddresses;
    string portName;
    int baudRate = 9600;
    string parity = "None";
    string stopBits = "One";
    string handshake = "None";
    bool allowTLSv10 = false;
    bool allowTLSv11 = false;
    bool allowTLSv12 = true;
    bool allowTLSv13 = true;
    string cipherList;
    string localCertFilePath;
    string peerCertFilePath;
    string privateKeyFilePath;
    int localLinkAddress = 1;
    int remoteLinkAddress = 1;
    int giInterval = 300;
    int class0ScanInterval = 0;
    int class1ScanInterval = 0;
    int class2ScanInterval = 0;
    int class3ScanInterval = 0;
    vector<RangeScan> rangeScans;
    int timeSyncMode = 0;
    bool enableUnsolicited = true;
    shared_ptr<IChannel> channel;
    shared_ptr<IMaster> master;
    shared_ptr<IMasterApplication> masterApplication;
    shared_ptr<ITaskCallback> scanTaskCallback;
    atomic<bool> isConnected{false};
};

int ProtocolDriverInstanceNumber = 1;
atomic<bool> Active{false};
JSONSCADAConfig JSConfig;
vector<shared_ptr<DNP3Connection>> DNP3conns;
mutex ConnectionsMutex;
mutex QueueMutex;
condition_variable QueueCv;
deque<Dnp3Value> DNP3DataQueue;

int64_t nowMs()
{
    return chrono::duration_cast<chrono::milliseconds>(chrono::system_clock::now().time_since_epoch()).count();
}

string upper(string value)
{
    transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return static_cast<char>(toupper(c)); });
    return value;
}

string resolvePath(const string& path)
{
    if (path.rfind("~/", 0) == 0)
    {
        const char* home = getenv("HOME");
        if (!home)
            home = getenv("USERPROFILE");
        if (home)
            return string(home) + path.substr(1);
    }
    return path;
}

bool fileExists(const string& path)
{
    ifstream file(path);
    return file.good();
}

double getDouble(const bsoncxx::document::view& doc, const string& key, double defaultValue = 0.0)
{
    auto value = doc[key];
    if (!value)
        return defaultValue;
    switch (value.type())
    {
    case bsoncxx::type::k_double:
        return value.get_double().value;
    case bsoncxx::type::k_int32:
        return value.get_int32().value;
    case bsoncxx::type::k_int64:
        return static_cast<double>(value.get_int64().value);
    case bsoncxx::type::k_bool:
        return value.get_bool().value ? 1.0 : 0.0;
    default:
        return defaultValue;
    }
}

bool getBool(const bsoncxx::document::view& doc, const string& key, bool defaultValue = false)
{
    auto value = doc[key];
    if (!value)
        return defaultValue;
    if (value.type() == bsoncxx::type::k_bool)
        return value.get_bool().value;
    return getDouble(doc, key, defaultValue ? 1 : 0) != 0;
}

string getString(const bsoncxx::document::view& doc, const string& key, const string& defaultValue = "")
{
    auto value = doc[key];
    if (!value)
        return defaultValue;
    if (value.type() == bsoncxx::type::k_string)
        return string(value.get_string().value);
    return defaultValue;
}

int64_t getDateMs(const bsoncxx::document::view& doc, const string& key, int64_t defaultValue = 0)
{
    auto value = doc[key];
    if (!value)
        return defaultValue;
    if (value.type() == bsoncxx::type::k_date)
        return value.get_date().value.count();
    if (value.type() == bsoncxx::type::k_int64)
        return value.get_int64().value;
    if (value.type() == bsoncxx::type::k_int32)
        return value.get_int32().value;
    return defaultValue;
}

vector<string> getStringArray(const bsoncxx::document::view& doc, const string& key)
{
    vector<string> result;
    auto value = doc[key];
    if (!value || value.type() != bsoncxx::type::k_array)
        return result;
    for (auto&& item : value.get_array().value)
    {
        if (item.type() == bsoncxx::type::k_string)
            result.emplace_back(string(item.get_string().value));
    }
    return result;
}

vector<RangeScan> getRangeScans(const bsoncxx::document::view& doc)
{
    vector<RangeScan> scans;
    auto value = doc["rangeScans"];
    if (!value || value.type() != bsoncxx::type::k_array)
        return scans;
    for (auto&& item : value.get_array().value)
    {
        auto v = item.get_document().view();
        RangeScan scan;
        scan.group = static_cast<int>(getDouble(v, "group", 1));
        scan.variation = static_cast<int>(getDouble(v, "variation", 1));
        scan.startAddress = static_cast<int>(getDouble(v, "startAddress", 0));
        scan.stopAddress = static_cast<int>(getDouble(v, "stopAddress", 0));
        scan.period = static_cast<int>(getDouble(v, "period", 0));
        scans.push_back(scan);
    }
    return scans;
}

JSONSCADAConfig loadJsonConfig(const string& path)
{
    ifstream file(path);
    if (!file.is_open())
        throw runtime_error("Missing config file " + path);
    auto j = json::parse(file);
    return {j.value("nodeName", ""), j.value("mongoConnectionString", ""), j.value("mongoDatabaseName", "")};
}

shared_ptr<mongocxx::client> connectMongoClient()
{
    return make_shared<mongocxx::client>(mongocxx::uri(JSConfig.mongoConnectionString));
}

bool isMongoLive(mongocxx::database& db)
{
    try
    {
        db.run_command(make_document(kvp("ping", 1)));
        return true;
    }
    catch (const exception&)
    {
        return false;
    }
}

void enqueueValue(const Dnp3Value& value)
{
    lock_guard<mutex> guard(QueueMutex);
    if (DNP3DataQueue.size() >= DataBufferLimit)
        DNP3DataQueue.pop_front();
    DNP3DataQueue.push_back(value);
    QueueCv.notify_one();
}

pair<string, uint16_t> parseEndpoint(const string& text, uint16_t defaultPort = 20000)
{
    auto pos = text.find(':');
    if (pos == string::npos)
        return {text, defaultPort};
    return {text.substr(0, pos), static_cast<uint16_t>(stoi(text.substr(pos + 1)))};
}

shared_ptr<DNP3Connection> findConnection(int number)
{
    lock_guard<mutex> guard(ConnectionsMutex);
    for (const auto& conn : DNP3conns)
    {
        if (conn->protocolConnectionNumber == number)
            return conn;
    }
    return {};
}

vector<shared_ptr<DNP3Connection>> snapshotConnections()
{
    lock_guard<mutex> guard(ConnectionsMutex);
    return DNP3conns;
}

class ChannelListener final : public IChannelListener
{
public:
    explicit ChannelListener(shared_ptr<DNP3Connection> conn) : conn(std::move(conn)) {}

    void OnStateChange(ChannelState state) override
    {
        conn->isConnected = state == ChannelState::OPEN;
        Log.log(conn->name + " - Channel state changed.");
        if (state != ChannelState::CLOSED)
            return;
        try
        {
            auto client = connectMongoClient();
            auto db = (*client)[JSConfig.mongoDatabaseName];
            auto collection = db[RealtimeDataCollectionName];
            auto filter = make_document(kvp("protocolSourceConnectionNumber", conn->protocolConnectionNumber));
            auto update = make_document(kvp("$set", make_document(
                kvp("invalid", true),
                kvp("timeTag", bsoncxx::types::b_date(chrono::milliseconds(nowMs()))))));
            collection.update_many(filter.view(), update.view());
        }
        catch (const exception& ex)
        {
            Log.log(conn->name + " - Failed to invalidate points: " + string(ex.what()), Logger::Level::Detailed);
        }
    }

private:
    shared_ptr<DNP3Connection> conn;
};

class SOEHandler final : public ISOEHandler
{
public:
    explicit SOEHandler(shared_ptr<DNP3Connection> conn) : conn(std::move(conn)) {}

    void BeginFragment(const ResponseInfo& info) override { 
        Log.log(conn->name + " - Begin Fragment: " + (info.unsolicited ? "Unsolicited" : "solicited"), Logger::Level::Detailed); 
    }
    void EndFragment(const ResponseInfo& info) override {
        Log.log(conn->name + " - End Fragment", Logger::Level::Detailed);
    }

    void Process(const HeaderInfo& info, const ICollection<Indexed<Binary>>& values) override { processBinary(info, values); }
    void Process(const HeaderInfo& info, const ICollection<Indexed<DoubleBitBinary>>& values) override { processDoubleBinary(info, values); }
    void Process(const HeaderInfo& info, const ICollection<Indexed<Analog>>& values) override { processAnalog(info, values); }
    void Process(const HeaderInfo& info, const ICollection<Indexed<Counter>>& values) override { processCounter(info, values, 20); }
    void Process(const HeaderInfo& info, const ICollection<Indexed<FrozenCounter>>& values) override { processFrozenCounter(info, values); }
    void Process(const HeaderInfo& info, const ICollection<Indexed<BinaryOutputStatus>>& values) override { processBinaryOutput(info, values); }
    void Process(const HeaderInfo& info, const ICollection<Indexed<AnalogOutputStatus>>& values) override { processAnalogOutputStatus(info, values); }
    void Process(const HeaderInfo& info, const ICollection<Indexed<OctetString>>& values) override { processOctetString(info, values); }
    void Process(const HeaderInfo& info, const ICollection<Indexed<TimeAndInterval>>& values) override { processTimeAndInterval(info, values); }
    void Process(const HeaderInfo& info, const ICollection<Indexed<BinaryCommandEvent>>& values) override { processBinaryCommandEvent(info, values); }
    void Process(const HeaderInfo& info, const ICollection<Indexed<AnalogCommandEvent>>& values) override { processAnalogCommandEvent(info, values); }
    void Process(const HeaderInfo& info, const ICollection<DNPTime>& values) override { processDNPTime(info, values); }

private:
    template <class T>
    void pushValue(int baseGroup, int group, int variation, const Indexed<T>& item, double value, const string& valueString,
        bool online, bool commLost, bool remoteForced, bool localForced, bool overrange, bool rollover,
        bool referenceError, bool transient)
    {
        Dnp3Value out;
        out.address = item.index;
        out.baseGroup = baseGroup;
        out.group = group;
        out.variation = variation;
        out.value = value;
        out.valueString = valueString;
        out.cot = 20;
        out.serverTimestamp = nowMs();
        
        out.hasSourceTimestamp = item.value.time.value > 0;
        out.sourceTimestamp = item.value.time.value;
        out.timeTagOk = item.value.time.quality == TimestampQuality::SYNCHRONIZED;
        
        Log.log(conn->name + " - Data Recv: addr=" + std::to_string(item.index) 
            + " group=" + std::to_string(group) + " val=" + valueString 
            + " time=" + std::to_string(item.value.time.value) 
            + " qual=" + std::to_string(static_cast<int>(item.value.time.quality)), 
            Logger::Level::Detailed);
        out.qOnline = online;
        out.qCommLost = commLost;
        out.qRemoteForced = remoteForced;
        out.qLocalForced = localForced;
        out.qOverrange = overrange;
        out.qRollover = rollover;
        out.qReferenceError = referenceError;
        out.qTransient = transient;
        out.connNumber = conn->protocolConnectionNumber;
        enqueueValue(out);
    }

    void processBinary(const HeaderInfo& info, const ICollection<Indexed<Binary>>& values)
    {
        Log.log(conn->name + " - Process Binary GV=" + std::to_string(static_cast<int>(info.gv)) + " Count=" + std::to_string(values.Count()), Logger::Level::Detailed);
        try
        {
            values.ForeachItem([&](const Indexed<Binary>& item) {
                pushValue(1, 1, 0, item, item.value.value ? 1.0 : 0.0, item.value.value ? "true" : "false",
                    (item.value.flags.value & static_cast<uint8_t>(BinaryQuality::ONLINE)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(BinaryQuality::COMM_LOST)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(BinaryQuality::REMOTE_FORCED)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(BinaryQuality::LOCAL_FORCED)) != 0,
                    false, false, false, false);
            });
        }
        catch (const std::exception& ex)
        {
            Log.log(conn->name + " - Exception in processBinary: " + string(ex.what()), Logger::Level::Detailed);
        }
    }

    void processDoubleBinary(const HeaderInfo& info, const ICollection<Indexed<DoubleBitBinary>>& values)
    {
        Log.log(conn->name + " - Process DoubleBinary GV=" + std::to_string(static_cast<int>(info.gv)) + " Count=" + std::to_string(values.Count()), Logger::Level::Detailed);
        try
        {
            values.ForeachItem([&](const Indexed<DoubleBitBinary>& item) {
                const bool transient = item.value.value == DoubleBit::INTERMEDIATE || item.value.value == DoubleBit::INDETERMINATE;
                const double value = (item.value.value == DoubleBit::DETERMINED_ON || item.value.value == DoubleBit::INDETERMINATE) ? 1.0 : 0.0;
                pushValue(3, 3, 0, item, value, std::to_string(static_cast<int>(item.value.value)),
                    (item.value.flags.value & static_cast<uint8_t>(DoubleBitBinaryQuality::ONLINE)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(DoubleBitBinaryQuality::COMM_LOST)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(DoubleBitBinaryQuality::REMOTE_FORCED)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(DoubleBitBinaryQuality::LOCAL_FORCED)) != 0,
                    false, false, false, transient);
            });
        }
        catch (const std::exception& ex)
        {
            Log.log(conn->name + " - Exception in processDoubleBinary: " + string(ex.what()), Logger::Level::Detailed);
        }
    }

    void processAnalog(const HeaderInfo& info, const ICollection<Indexed<Analog>>& values)
    {
        Log.log(conn->name + " - Process Analog GV=" + std::to_string(static_cast<int>(info.gv)) + " Count=" + std::to_string(values.Count()), Logger::Level::Detailed);
        try
        {
            values.ForeachItem([&](const Indexed<Analog>& item) {
                pushValue(30, 30, 0, item, item.value.value, std::to_string(item.value.value),
                    (item.value.flags.value & static_cast<uint8_t>(AnalogQuality::ONLINE)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(AnalogQuality::COMM_LOST)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(AnalogQuality::REMOTE_FORCED)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(AnalogQuality::LOCAL_FORCED)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(AnalogQuality::OVERRANGE)) != 0,
                    false,
                    (item.value.flags.value & static_cast<uint8_t>(AnalogQuality::REFERENCE_ERR)) != 0,
                    false);
            });
        }
        catch (const std::exception& ex)
        {
            Log.log(conn->name + " - Exception in processAnalog: " + string(ex.what()), Logger::Level::Detailed);
        }
    }

    void processCounter(const HeaderInfo& info, const ICollection<Indexed<Counter>>& values, int baseGroup)
    {
        Log.log(conn->name + " - Process Counter GV=" + std::to_string(static_cast<int>(info.gv)) + " Count=" + std::to_string(values.Count()), Logger::Level::Detailed);
        try
        {
            values.ForeachItem([&](const Indexed<Counter>& item) {
                pushValue(baseGroup, baseGroup, 0, item, item.value.value, std::to_string(item.value.value),
                    (item.value.flags.value & static_cast<uint8_t>(CounterQuality::ONLINE)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(CounterQuality::COMM_LOST)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(CounterQuality::REMOTE_FORCED)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(CounterQuality::LOCAL_FORCED)) != 0,
                    false,
                    (item.value.flags.value & static_cast<uint8_t>(CounterQuality::ROLLOVER)) != 0,
                    false,
                    false);
            });
        }
        catch (const std::exception& ex)
        {
            Log.log(conn->name + " - Exception in processCounter: " + string(ex.what()), Logger::Level::Detailed);
        }
    }

    void processFrozenCounter(const HeaderInfo& info, const ICollection<Indexed<FrozenCounter>>& values)
    {
        Log.log(conn->name + " - Process FrozenCounter GV=" + std::to_string(static_cast<int>(info.gv)) + " Count=" + std::to_string(values.Count()), Logger::Level::Detailed);
        try
        {
            values.ForeachItem([&](const Indexed<FrozenCounter>& item) {
                pushValue(23, 23, 0, item, item.value.value, std::to_string(item.value.value),
                    (item.value.flags.value & static_cast<uint8_t>(CounterQuality::ONLINE)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(CounterQuality::COMM_LOST)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(CounterQuality::REMOTE_FORCED)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(CounterQuality::LOCAL_FORCED)) != 0,
                    false,
                    (item.value.flags.value & static_cast<uint8_t>(CounterQuality::ROLLOVER)) != 0,
                    false,
                    false);
            });
        }
        catch (const std::exception& ex)
        {
            Log.log(conn->name + " - Exception in processFrozenCounter: " + string(ex.what()), Logger::Level::Detailed);
        }
    }

    void processBinaryOutput(const HeaderInfo& info, const ICollection<Indexed<BinaryOutputStatus>>& values)
    {
        Log.log(conn->name + " - Process BinaryOutputStatus GV=" + std::to_string(static_cast<int>(info.gv)) + " Count=" + std::to_string(values.Count()), Logger::Level::Detailed);
        try
        {
            values.ForeachItem([&](const Indexed<BinaryOutputStatus>& item) {
                pushValue(10, 10, 0, item, item.value.value ? 1.0 : 0.0, item.value.value ? "true" : "false",
                    (item.value.flags.value & static_cast<uint8_t>(BinaryOutputStatusQuality::ONLINE)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(BinaryOutputStatusQuality::COMM_LOST)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(BinaryOutputStatusQuality::REMOTE_FORCED)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(BinaryOutputStatusQuality::LOCAL_FORCED)) != 0,
                    false, false, false, false);
            });
        }
        catch (const std::exception& ex)
        {
            Log.log(conn->name + " - Exception in processBinaryOutput: " + string(ex.what()), Logger::Level::Detailed);
        }
    }

    void processAnalogOutputStatus(const HeaderInfo& info, const ICollection<Indexed<AnalogOutputStatus>>& values)
    {
        Log.log(conn->name + " - Process AnalogOutputStatus GV=" + std::to_string(static_cast<int>(info.gv)) + " Count=" + std::to_string(values.Count()), Logger::Level::Detailed);
        try
        {
            values.ForeachItem([&](const Indexed<AnalogOutputStatus>& item) {
                pushValue(40, 40, 0, item, item.value.value, std::to_string(item.value.value),
                    (item.value.flags.value & static_cast<uint8_t>(AnalogOutputStatusQuality::ONLINE)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(AnalogOutputStatusQuality::COMM_LOST)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(AnalogOutputStatusQuality::REMOTE_FORCED)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(AnalogOutputStatusQuality::LOCAL_FORCED)) != 0,
                    (item.value.flags.value & static_cast<uint8_t>(AnalogOutputStatusQuality::OVERRANGE)) != 0,
                    false,
                    (item.value.flags.value & static_cast<uint8_t>(AnalogOutputStatusQuality::REFERENCE_ERR)) != 0,
                    false);
            });
        }
        catch (const std::exception& ex)
        {
            Log.log(conn->name + " - Exception in processAnalogOutputStatus: " + string(ex.what()), Logger::Level::Detailed);
        }
    }

    template <class T>
    void processAnalogCommand(const HeaderInfo&, const ICollection<Indexed<T>>& values, int variation)
    {
        values.ForeachItem([&](const Indexed<T>& item) {
            Dnp3Value out;
            out.address = item.index;
            out.baseGroup = 41;
            out.group = 41;
            out.variation = variation;
            out.value = static_cast<double>(item.value.value);
            out.valueString = std::to_string(out.value);
            out.serverTimestamp = nowMs();
            out.connNumber = conn->protocolConnectionNumber;
            enqueueValue(out);
        });
    }

    void processOctetString(const HeaderInfo&, const ICollection<Indexed<OctetString>>& values)
    {
        // OctetString data - not currently processed
        (void)values;
    }

    void processTimeAndInterval(const HeaderInfo&, const ICollection<Indexed<TimeAndInterval>>& values)
    {
        // TimeAndInterval data - not currently processed
        (void)values;
    }

    void processBinaryCommandEvent(const HeaderInfo&, const ICollection<Indexed<BinaryCommandEvent>>& values)
    {
        // BinaryCommandEvent data - not currently processed
        (void)values;
    }

    void processAnalogCommandEvent(const HeaderInfo&, const ICollection<Indexed<AnalogCommandEvent>>& values)
    {
        // AnalogCommandEvent data - not currently processed
        (void)values;
    }

    void processDNPTime(const HeaderInfo&, const ICollection<DNPTime>& values)
    {
        // DNPTime data - not currently processed
        (void)values;
    }

    shared_ptr<DNP3Connection> conn;
};

string taskCompletionToString(TaskCompletion result)
{
    switch (result)
    {
    case TaskCompletion::SUCCESS:
        return "SUCCESS";
    case TaskCompletion::FAILURE_BAD_RESPONSE:
        return "FAILURE_BAD_RESPONSE";
    case TaskCompletion::FAILURE_RESPONSE_TIMEOUT:
        return "FAILURE_RESPONSE_TIMEOUT";
    case TaskCompletion::FAILURE_START_TIMEOUT:
        return "FAILURE_START_TIMEOUT";
    case TaskCompletion::FAILURE_NO_COMMS:
        return "FAILURE_NO_COMMS";
    case TaskCompletion::FAILURE_MESSAGE_FORMAT_ERROR:
        return "FAILURE_MESSAGE_FORMAT_ERROR";
    default:
        return "UNKNOWN(" + to_string(static_cast<int>(result)) + ")";
    }
}

string masterTaskTypeToString(MasterTaskType type)
{
    switch (type)
    {
    case MasterTaskType::CLEAR_RESTART:
        return "CLEAR_RESTART";
    case MasterTaskType::DISABLE_UNSOLICITED:
        return "DISABLE_UNSOLICITED";
    case MasterTaskType::ASSIGN_CLASS:
        return "ASSIGN_CLASS";
    case MasterTaskType::STARTUP_INTEGRITY_POLL:
        return "STARTUP_INTEGRITY_POLL";
    case MasterTaskType::NON_LAN_TIME_SYNC:
        return "NON_LAN_TIME_SYNC";
    case MasterTaskType::LAN_TIME_SYNC:
        return "LAN_TIME_SYNC";
    case MasterTaskType::ENABLE_UNSOLICITED:
        return "ENABLE_UNSOLICITED";
    case MasterTaskType::AUTO_EVENT_SCAN:
        return "AUTO_EVENT_SCAN";
    case MasterTaskType::USER_TASK:
        return "USER_TASK";
    default:
        return "UNKNOWN(" + to_string(static_cast<int>(type)) + ")";
    }
}

string formatIIN(const IINField& iin)
{
    ostringstream ss;
    ss << "LSB=0x" << hex << setw(2) << setfill('0') << static_cast<int>(iin.LSB)
       << " MSB=0x" << setw(2) << static_cast<int>(iin.MSB) << dec;
    return ss.str();
}

class MasterApplication final : public IMasterApplication
{
public:
    explicit MasterApplication(shared_ptr<DNP3Connection> conn) : conn(std::move(conn)) {}

    void OnReceiveIIN(const IINField& iin) override
    {
        Log.log(conn->name + " - Received IIN: " + formatIIN(iin), Logger::Level::Detailed);
    }

    void OnTaskStart(MasterTaskType type, TaskId) override
    {
        Log.log(conn->name + " - Task start: " + masterTaskTypeToString(type), Logger::Level::Detailed);
    }

    void OnTaskComplete(const TaskInfo& info) override
    {
        Log.log(conn->name + " - Task complete: " + masterTaskTypeToString(info.type) + " result=" + taskCompletionToString(info.result),
            Logger::Level::Detailed);
    }

    void OnOpen() override
    {
        Log.log(conn->name + " - Application layer opened", Logger::Level::Detailed);
    }

    void OnClose() override
    {
        Log.log(conn->name + " - Application layer closed", Logger::Level::Detailed);
    }

    bool AssignClassDuringStartup() override
    {
        return false;
    }

    void ConfigureAssignClassRequest(const WriteHeaderFunT&) override {}

    UTCTimestamp Now() override
    {
        return UTCTimestamp(nowMs());
    }

    void OnStateChange(LinkStatus value) override
    {
        Log.log(conn->name + " - Link state change: " + to_string(static_cast<int>(value)), Logger::Level::Detailed);
    }

private:
    shared_ptr<DNP3Connection> conn;
};

class ScanTaskCallback final : public ITaskCallback
{
public:
    explicit ScanTaskCallback(shared_ptr<DNP3Connection> conn) : conn(std::move(conn)) {}

    void OnStart() override
    {
        Log.log(conn->name + " - Scan task callback start", Logger::Level::Detailed);
    }

    void OnComplete(TaskCompletion result) override
    {
        Log.log(conn->name + " - Scan task callback complete: " + taskCompletionToString(result), Logger::Level::Detailed);
    }

    void OnDestroyed() override
    {
        Log.log(conn->name + " - Scan task callback destroyed", Logger::Level::Detailed);
    }

private:
    shared_ptr<DNP3Connection> conn;
};

shared_ptr<IChannel> tryReuseChannel(const shared_ptr<DNP3Connection>& conn)
{
    for (const auto& existing : snapshotConnections())
    {
        if (existing.get() == conn.get() || !existing->channel)
            continue;
        if ((conn->connectionMode == "TCP ACTIVE" || conn->connectionMode == "TLS ACTIVE") && existing->ipAddresses == conn->ipAddresses)
            return existing->channel;
        if ((conn->connectionMode == "TCP PASSIVE" || conn->connectionMode == "TLS PASSIVE") && existing->ipAddressLocalBind == conn->ipAddressLocalBind)
            return existing->channel;
        if (conn->connectionMode == "SERIAL" && !conn->portName.empty() && conn->portName == existing->portName)
            return existing->channel;
        if (conn->connectionMode == "UDP" && conn->ipAddressLocalBind == existing->ipAddressLocalBind && conn->ipAddresses == existing->ipAddresses)
            return existing->channel;
    }
    return {};
}

shared_ptr<IChannel> createChannel(const shared_ptr<DNP3Manager>& manager, const shared_ptr<DNP3Connection>& conn, LogLevels logLevel)
{
    if (auto reused = tryReuseChannel(conn))
        return reused;

    auto listener = make_shared<ChannelListener>(conn);
    if (conn->connectionMode == "TCP ACTIVE")
    {
        auto remote = parseEndpoint(conn->ipAddresses.front());
        auto bindHost = conn->ipAddressLocalBind.empty() ? string("0.0.0.0") : parseEndpoint(conn->ipAddressLocalBind).first;
        return manager->AddTCPClient(conn->name, logLevel, ChannelRetry::Default(),
            vector<IPEndpoint>{IPEndpoint(remote.first, remote.second)}, bindHost, listener);
    }
    if (conn->connectionMode == "TCP PASSIVE")
    {
        auto local = parseEndpoint(conn->ipAddressLocalBind.empty() ? string("0.0.0.0:20000") : conn->ipAddressLocalBind);
        return manager->AddTCPServer(conn->name, logLevel, ServerAcceptMode::CloseNew, IPEndpoint(local.first, local.second), listener);
    }
    if (conn->connectionMode == "TLS ACTIVE")
    {
        auto remote = parseEndpoint(conn->ipAddresses.front());
        auto bindHost = conn->ipAddressLocalBind.empty() ? string("0.0.0.0") : parseEndpoint(conn->ipAddressLocalBind).first;
        auto tlsConfig = TLSConfig(conn->peerCertFilePath, conn->localCertFilePath, conn->privateKeyFilePath,
            conn->allowTLSv10, conn->allowTLSv11, conn->allowTLSv12, conn->allowTLSv13, conn->cipherList);
        return manager->AddTLSClient(conn->name, logLevel, ChannelRetry::Default(),
            vector<IPEndpoint>{IPEndpoint(remote.first, remote.second)}, bindHost, tlsConfig, listener);
    }
    if (conn->connectionMode == "TLS PASSIVE")
    {
        auto local = parseEndpoint(conn->ipAddressLocalBind.empty() ? string("0.0.0.0:20000") : conn->ipAddressLocalBind);
        auto tlsConfig = TLSConfig(conn->peerCertFilePath, conn->localCertFilePath, conn->privateKeyFilePath,
            conn->allowTLSv10, conn->allowTLSv11, conn->allowTLSv12, conn->allowTLSv13, conn->cipherList);
        return manager->AddTLSServer(conn->name, logLevel, ServerAcceptMode::CloseNew, IPEndpoint(local.first, local.second), tlsConfig, listener);
    }
    if (conn->connectionMode == "SERIAL")
    {
        SerialSettings settings;
        settings.deviceName = conn->portName;
        settings.baud = conn->baudRate;
        settings.dataBits = 8;
        settings.parity = conn->parity == "Even" ? Parity::Even : conn->parity == "Odd" ? Parity::Odd : Parity::None;
        settings.stopBits = (conn->stopBits == "Two" || conn->stopBits == "2") ? StopBits::Two : StopBits::One;
        settings.flowType = conn->handshake == "XON" ? FlowControl::XONXOFF : conn->handshake == "RTS" ? FlowControl::Hardware : FlowControl::None;
        return manager->AddSerial(conn->name, logLevel, ChannelRetry::Default(), settings, listener);
    }
    if (conn->connectionMode == "UDP")
    {
        auto local = parseEndpoint(conn->ipAddressLocalBind);
        auto remote = parseEndpoint(conn->ipAddresses.front());
        return manager->AddUDPChannel(conn->name, logLevel, ChannelRetry::Default(), IPEndpoint(local.first, local.second), IPEndpoint(remote.first, remote.second), listener);
    }
    throw runtime_error("Unsupported connectionMode");
}

void configureMaster(const shared_ptr<DNP3Connection>& conn)
{
    MasterStackConfig config;
    config.link.LocalAddr = static_cast<uint16_t>(conn->localLinkAddress);
    config.link.RemoteAddr = static_cast<uint16_t>(conn->remoteLinkAddress);
    config.master.startupIntegrityClassMask = ClassField::AllClasses();
    config.master.timeSyncMode = TimeSyncMode::None;
    if (conn->timeSyncMode >= 2)
        config.master.timeSyncMode = TimeSyncMode::LAN;
    else if (conn->timeSyncMode == 1)
        config.master.timeSyncMode = TimeSyncMode::NonLAN;
    if (conn->enableUnsolicited)
    {
        config.master.disableUnsolOnStartup = false;
        config.master.unsolClassMask = ClassField::AllClasses();
    }
    else
    {
        config.master.disableUnsolOnStartup = true;
        config.master.unsolClassMask = ClassField::None();
    }

    auto soe = make_shared<SOEHandler>(conn);
    conn->masterApplication = make_shared<MasterApplication>(conn);
    conn->scanTaskCallback = make_shared<ScanTaskCallback>(conn);
    auto scanConfig = TaskConfig::With(conn->scanTaskCallback);
    conn->master = conn->channel->AddMaster(conn->name, soe, conn->masterApplication, config);
    if (conn->giInterval > 0)
        conn->master->AddClassScan(ClassField::AllClasses(), TimeDuration::Seconds(conn->giInterval), soe, scanConfig);
    if (conn->class0ScanInterval > 0)
        conn->master->AddClassScan(ClassField(PointClass::Class0), TimeDuration::Seconds(conn->class0ScanInterval), soe, scanConfig);
    if (conn->class1ScanInterval > 0)
        conn->master->AddClassScan(ClassField(PointClass::Class1), TimeDuration::Seconds(conn->class1ScanInterval), soe, scanConfig);
    if (conn->class2ScanInterval > 0)
        conn->master->AddClassScan(ClassField(PointClass::Class2), TimeDuration::Seconds(conn->class2ScanInterval), soe, scanConfig);
    if (conn->class3ScanInterval > 0)
        conn->master->AddClassScan(ClassField(PointClass::Class3), TimeDuration::Seconds(conn->class3ScanInterval), soe, scanConfig);
    for (const auto& scan : conn->rangeScans)
    {
        if (scan.period > 0)
            conn->master->AddRangeScan(GroupVariationID(scan.group, scan.variation),
                static_cast<uint16_t>(scan.startAddress), static_cast<uint16_t>(scan.stopAddress), TimeDuration::Seconds(scan.period), soe, scanConfig);
    }
    conn->master->Disable();
    conn->isConnected = false;
    Log.log(conn->name + " - Master created in disabled state; waiting for redundancy activation.", Logger::Level::Detailed);
}

void processMongo()
{
    Log.log("processMongo: Function entered");
    try
    {
        Log.log("processMongo thread started");
        for (;;)
        {
            try
            {
            Log.log("processMongo: Connecting to MongoDB...", Logger::Level::Detailed);
            auto client = connectMongoClient();
            auto db = (*client)[JSConfig.mongoDatabaseName];
            auto collection = db[RealtimeDataCollectionName];
            Log.log("processMongo: Connected to MongoDB", Logger::Level::Detailed);
            for (;;)
            {
                unique_lock<mutex> lock(QueueMutex);
                QueueCv.wait_for(lock, chrono::milliseconds(100), [] { return !DNP3DataQueue.empty(); });
                deque<Dnp3Value> batch;
                batch.swap(DNP3DataQueue);
                lock.unlock();

                if (!isMongoLive(db))
                {
                    Log.log("processMongo: MongoDB connection lost, attempting reconnect...", Logger::Level::Detailed);
                    throw runtime_error("MongoDB connection failed");
                }
                if (batch.empty())
                    continue;

                vector<mongocxx::model::write> writes;
                vector<bsoncxx::document::value> filterStore;
                vector<bsoncxx::document::value> updateStore;
                filterStore.reserve(batch.size());
                updateStore.reserve(batch.size());

                for (const auto& iv : batch)
                {
                    try {
                        // Validate value to prevent BSON corruption
                        double safeValue = iv.value;
                        if (!std::isfinite(iv.value) || iv.value > 1e100 || iv.value < -1e100) {
                            Log.log("Mongo: Skipping invalid value: address=" + std::to_string(iv.address) + " value=" + std::to_string(iv.value), Logger::Level::Detailed);
                            continue;
                        }
                        
                        // Validate timestamp - must be positive and reasonable
                        int64_t safeServerTime = iv.serverTimestamp;
                        if (safeServerTime < 1000000000000 || safeServerTime > 2000000000000) safeServerTime = 0; // Reasonable range 2001-2033
                        int64_t safeSourceTime = iv.hasSourceTimestamp ? iv.sourceTimestamp : 0;
                        if (safeSourceTime < 1000000000000 || safeSourceTime > 2000000000000) safeSourceTime = 0;

                        Log.log("Mongo: Writing data conn=" + std::to_string(iv.connNumber) + " addr=" + std::to_string(iv.address) + " group=" + std::to_string(iv.baseGroup) + " value=" + std::to_string(safeValue), Logger::Level::Detailed);

                        filterStore.push_back(make_document(
                            kvp("protocolSourceConnectionNumber", iv.connNumber),
                            kvp("protocolSourceCommonAddress", iv.baseGroup),
                            kvp("protocolSourceObjectAddress", iv.address)));
                        
                        updateStore.push_back(make_document(kvp("$set", make_document(
                            kvp("sourceDataUpdate", make_document(
                                kvp("valueAtSource", safeValue),
                                kvp("valueStringAtSource", iv.valueString),
                                kvp("asduAtSource", std::to_string(iv.group) + " " + std::to_string(iv.variation)),
                                kvp("causeOfTransmissionAtSource", std::to_string(iv.cot)),
                                kvp("timeTagAtSource", bsoncxx::types::b_date(chrono::milliseconds(safeSourceTime))),
                                kvp("timeTagAtSourceOk", iv.timeTagOk),
                                kvp("timeTag", bsoncxx::types::b_date(chrono::milliseconds(safeServerTime))),
                                kvp("notTopicalAtSource", iv.qCommLost),
                                kvp("invalidAtSource", iv.qCommLost || iv.qReferenceError || !iv.qOnline),
                                kvp("overflowAtSource", iv.qOverrange),
                                kvp("blockedAtSource", !iv.qOnline),
                                kvp("substitutedAtSource", iv.qRemoteForced || iv.qLocalForced),
                                kvp("carryAtSource", iv.qRollover),
                                kvp("transientAtSource", iv.qTransient),
                                kvp("originator", ProtocolDriverName + "|" + std::to_string(iv.connNumber))))))));

                        mongocxx::model::update_one op(filterStore.back().view(), updateStore.back().view());
                        writes.emplace_back(std::move(op));
                    } catch (const std::exception& ex) {
                        Log.log("Mongo: Error processing data: " + string(ex.what()), Logger::Level::Detailed);
                    }
                }
                if (!writes.empty())
                    collection.bulk_write(writes);
            }
        }
        catch (const exception& ex)
        {
            Log.log("Exception Mongo: " + string(ex.what()));
            this_thread::sleep_for(chrono::seconds(3));
        }
    }
    }
    catch (const exception& ex)
    {
        Log.log("FATAL processMongo: " + string(ex.what()));
    }
}

void cancelCommand(mongocxx::collection& collection, const bsoncxx::oid& id, const string& reason)
{
    auto filter = make_document(kvp("_id", id));
    auto update = make_document(kvp("$set", make_document(kvp("cancelReason", reason))));
    collection.update_one(filter.view(), update.view());
}

void ackCommand(mongocxx::collection& collection, const bsoncxx::oid& id, bool ack, const string& resultDescription)
{
    auto filter = make_document(kvp("_id", id));
    auto update = make_document(kvp("$set", make_document(
        kvp("delivered", true),
        kvp("ack", ack),
        kvp("ackTimeTag", bsoncxx::types::b_date(chrono::milliseconds(nowMs()))),
        kvp("resultDescription", resultDescription))));
    collection.update_one(filter.view(), update.view());
}

void executeCommand(const bsoncxx::document::view& command, mongocxx::collection& collection)
{
    if (!Active)
        return;

    const auto id = command["_id"].get_oid().value;
    const auto conn = findConnection(static_cast<int>(getDouble(command, "protocolSourceConnectionNumber")));
    if (!conn || !conn->master)
    {
        cancelCommand(collection, id, "connection_not_found");
        return;
    }
    if (!conn->isConnected || !conn->commandsEnabled)
    {
        cancelCommand(collection, id, "not_connected");
        return;
    }
    if (nowMs() - getDateMs(command, "timeTag", nowMs()) > 10000)
    {
        cancelCommand(collection, id, "expired");
        return;
    }

    const int group = static_cast<int>(getDouble(command, "protocolSourceCommonAddress"));
    const int variation = static_cast<int>(getDouble(command, "protocolSourceASDU"));
    const auto index = static_cast<uint16_t>(getDouble(command, "protocolSourceObjectAddress"));
    const bool useSbo = getBool(command, "protocolSourceCommandUseSBO");
    const double value = getDouble(command, "value");
    const int duration = static_cast<int>(getDouble(command, "protocolSourceCommandDuration"));

    auto callback = [id, collection](const ICommandTaskResult& result) mutable {
        const bool ok = result.summary == TaskCompletion::SUCCESS;
        std::string resultStr;
        switch (result.summary) {
            case TaskCompletion::SUCCESS: resultStr = "SUCCESS"; break;
            case TaskCompletion::FAILURE_BAD_RESPONSE: resultStr = "FAILURE_BAD_RESPONSE"; break;
            case TaskCompletion::FAILURE_RESPONSE_TIMEOUT: resultStr = "FAILURE_RESPONSE_TIMEOUT"; break;
            case TaskCompletion::FAILURE_START_TIMEOUT: resultStr = "FAILURE_START_TIMEOUT"; break;
            case TaskCompletion::FAILURE_MESSAGE_FORMAT_ERROR: resultStr = "FAILURE_MESSAGE_FORMAT_ERROR"; break;
            case TaskCompletion::FAILURE_NO_COMMS: resultStr = "FAILURE_NO_COMMS"; break;
            default: resultStr = "UNKNOWN"; break;
        }
        ackCommand(collection, id, ok, resultStr);
    };

    if (group == 12)
    {
        OperationType operation = OperationType::NUL;
        TripCloseCode tripCloseCode = TripCloseCode::NUL;
        uint32_t onTime = 0;
        uint32_t offTime = 0;
        switch (duration)
        {
        case 1:
            onTime = CROB_PulseOnTime; offTime = CROB_PulseOffTime; operation = value != 0 ? OperationType::PULSE_ON : OperationType::PULSE_OFF; break;
        case 2:
            onTime = CROB_PulseOnTime; offTime = CROB_PulseOffTime; operation = value != 0 ? OperationType::PULSE_OFF : OperationType::PULSE_ON; break;
        case 3:
            operation = value != 0 ? OperationType::LATCH_ON : OperationType::LATCH_OFF; break;
        case 4:
            operation = value != 0 ? OperationType::LATCH_OFF : OperationType::LATCH_ON; break;
        case 11:
            onTime = CROB_PulseOnTime; offTime = CROB_PulseOffTime; operation = value != 0 ? OperationType::PULSE_ON : OperationType::PULSE_OFF; tripCloseCode = value != 0 ? TripCloseCode::CLOSE : TripCloseCode::TRIP; break;
        case 13:
            operation = value != 0 ? OperationType::LATCH_ON : OperationType::LATCH_OFF; tripCloseCode = value != 0 ? TripCloseCode::CLOSE : TripCloseCode::TRIP; break;
        case 21:
            onTime = CROB_PulseOnTime; offTime = CROB_PulseOffTime; operation = value != 0 ? OperationType::PULSE_ON : OperationType::PULSE_OFF; tripCloseCode = value != 0 ? TripCloseCode::TRIP : TripCloseCode::CLOSE; break;
        case 23:
            operation = value != 0 ? OperationType::LATCH_ON : OperationType::LATCH_OFF; tripCloseCode = value != 0 ? TripCloseCode::TRIP : TripCloseCode::CLOSE; break;
        }
        ControlRelayOutputBlock crob(operation, tripCloseCode, false, 1, onTime, offTime);
        if (useSbo)
            conn->master->SelectAndOperate(crob, index, callback, TaskConfig::Default());
        else
            conn->master->DirectOperate(crob, index, callback, TaskConfig::Default());
        return;
    }
    if (group == 41 && variation == 1)
    {
        if (useSbo) conn->master->SelectAndOperate(AnalogOutputInt32(static_cast<int32_t>(value)), index, callback, TaskConfig::Default());
        else conn->master->DirectOperate(AnalogOutputInt32(static_cast<int32_t>(value)), index, callback, TaskConfig::Default());
        return;
    }
    if (group == 41 && variation == 2)
    {
        if (useSbo) conn->master->SelectAndOperate(AnalogOutputInt16(static_cast<int16_t>(value)), index, callback, TaskConfig::Default());
        else conn->master->DirectOperate(AnalogOutputInt16(static_cast<int16_t>(value)), index, callback, TaskConfig::Default());
        return;
    }
    if (group == 41 && variation == 4)
    {
        if (useSbo) conn->master->SelectAndOperate(AnalogOutputDouble64(value), index, callback, TaskConfig::Default());
        else conn->master->DirectOperate(AnalogOutputDouble64(value), index, callback, TaskConfig::Default());
        return;
    }
    if (group == 41)
    {
        if (useSbo) conn->master->SelectAndOperate(AnalogOutputFloat32(static_cast<float>(value)), index, callback, TaskConfig::Default());
        else conn->master->DirectOperate(AnalogOutputFloat32(static_cast<float>(value)), index, callback, TaskConfig::Default());
        return;
    }

    cancelCommand(collection, id, "unsupported_group");
}

void processMongoCmd()
{
    for (;;)
    {
        try
        {
            auto client = connectMongoClient();
            auto db = (*client)[JSConfig.mongoDatabaseName];
            auto collection = db[CommandsQueueCollectionName];
            mongocxx::pipeline pipeline;
            pipeline.match(make_document(kvp("operationType", "insert")));
            auto cursor = collection.watch(pipeline);
            for (auto&& change : cursor)
            {
                auto fullDocument = change["fullDocument"];
                if (fullDocument && fullDocument.type() == bsoncxx::type::k_document)
                    executeCommand(fullDocument.get_document().view(), collection);
            }
        }
        catch (const exception& ex)
        {
            Log.log("Exception Mongo CMD: " + string(ex.what()));
            this_thread::sleep_for(chrono::seconds(3));
        }
    }
}

void processRedundancy()
{
    constexpr int64_t RedundancyStaleTimeoutMs = 15000;
    for (;;)
    {
        try
        {
            auto client = connectMongoClient();
            auto db = (*client)[JSConfig.mongoDatabaseName];
            auto instances = db[ProtocolDriverInstancesCollectionName];
            auto connections = db[ProtocolConnectionsCollectionName];
            for (;;)
            {
                if (!isMongoLive(db))
                    throw runtime_error("MongoDB connection failed");

                auto instance = instances.find_one(make_document(
                    kvp("protocolDriver", ProtocolDriverName),
                    kvp("protocolDriverInstanceNumber", ProtocolDriverInstanceNumber)));
                bool shouldBeActive = true;
                if (instance)
                {
                    auto view = instance->view();
                    const auto activeNode = getString(view, "activeNodeName");
                    shouldBeActive = activeNode == JSConfig.nodeName;
                    if (!shouldBeActive && !activeNode.empty())
                    {
                        const auto keepAlive = getDateMs(view, "activeNodeKeepAliveTimeTag");
                        const auto keepAliveAge = keepAlive > 0 ? nowMs() - keepAlive : RedundancyStaleTimeoutMs + 1;
                        if (keepAliveAge > RedundancyStaleTimeoutMs)
                            shouldBeActive = true;
                    }
                }

                const bool becameActive = shouldBeActive && !Active.load();
                const bool becameInactive = !shouldBeActive && Active.load();
                Active = shouldBeActive;
                if (becameActive)
                {
                    Log.log("Redundancy - ACTIVATING this node!");
                    try
                    {
                        for (const auto& conn : snapshotConnections())
                        {
                            if (conn->master)
                            {
                                Log.log(conn->name + " - Enabling master...", Logger::Level::Detailed);
                                conn->master->Enable();
                                Log.log(conn->name + " - Master enabled successfully", Logger::Level::Detailed);
                            }
                        }
                    }
                    catch (const std::exception& ex)
                    {
                        Log.log(std::string("Exception enabling master: ") + ex.what(), Logger::Level::Detailed);
                    }
                }
                if (becameInactive)
                {
                    Log.log("Redundancy - DEACTIVATING this node.");
                    for (const auto& conn : snapshotConnections())
                    {
                        if (conn->master)
                            conn->master->Disable();
                        conn->isConnected = false;
                    }
                }
                else if (!Active)
                {
                    Log.log("Redundancy - Node is STANDBY; masters remain disabled.", Logger::Level::Detailed);
                }

                if (Active)
                {
                    instances.find_one_and_update(
                        make_document(kvp("protocolDriver", ProtocolDriverName), kvp("protocolDriverInstanceNumber", ProtocolDriverInstanceNumber)),
                        make_document(kvp("$set", make_document(
                            kvp("activeNodeName", JSConfig.nodeName),
                            kvp("activeNodeKeepAliveTimeTag", bsoncxx::types::b_date(chrono::milliseconds(nowMs())))))));

                    for (const auto& conn : snapshotConnections())
                    {
                        if (!conn->channel)
                            continue;
                        auto stats = conn->channel->GetStatistics();
                        auto filter = make_document(kvp("protocolConnectionNumber", conn->protocolConnectionNumber));
                        auto update = make_document(kvp("$set", make_document(
                            kvp("stats", make_document(
                                kvp("nodeName", JSConfig.nodeName),
                                kvp("timeTag", bsoncxx::types::b_date(chrono::milliseconds(nowMs()))),
                                kvp("isConnected", conn->isConnected.load()),
                                kvp("numHeaderCrcError", static_cast<int64_t>(stats.parser.numHeaderCrcError)),
                                kvp("numBodyCrcError", static_cast<int64_t>(stats.parser.numBodyCrcError)),
                                kvp("numBytesRx", static_cast<int64_t>(stats.channel.numBytesRx)),
                                kvp("numBytesTx", static_cast<int64_t>(stats.channel.numBytesTx)),
                                kvp("numClose", static_cast<int64_t>(stats.channel.numClose)),
                                kvp("numLinkFrameRx", static_cast<int64_t>(stats.parser.numLinkFrameRx)),
                                kvp("numLinkFrameTx", static_cast<int64_t>(stats.channel.numLinkFrameTx)),
                                kvp("numOpen", static_cast<int64_t>(stats.channel.numOpen)),
                                kvp("numOpenFail", static_cast<int64_t>(stats.channel.numOpenFail)))))));
                        connections.update_one(filter.view(), update.view());
                    }
                }

                this_thread::sleep_for(chrono::seconds(5));
            }
        }
        catch (const exception& ex)
        {
            Log.log("Exception Mongo Redundancy: " + string(ex.what()));
            this_thread::sleep_for(chrono::seconds(3));
        }
    }
}

LogLevels mapLogLevel()
{
    if (Log.getLevel() >= Logger::Level::Debug)
        return levels::ALL;
    if (Log.getLevel() >= Logger::Level::Detailed)
        return levels::NORMAL | levels::ALL_COMMS;
    if (Log.getLevel() >= Logger::Level::Basic)
        return levels::NORMAL;
    return levels::NOTHING;
}

void loadConnections(bool applyInstanceLogLevel = true)
{
    auto client = connectMongoClient();
    auto db = (*client)[JSConfig.mongoDatabaseName];
    auto instances = db[ProtocolDriverInstancesCollectionName];
    auto connections = db[ProtocolConnectionsCollectionName];

    auto instance = instances.find_one(make_document(
        kvp("protocolDriver", ProtocolDriverName),
        kvp("protocolDriverInstanceNumber", ProtocolDriverInstanceNumber),
        kvp("enabled", true)));
    if (!instance)
        throw runtime_error("Driver instance not found");
    if (applyInstanceLogLevel && instance->view()["logLevel"])
        Log.setLevel(static_cast<int>(getDouble(instance->view(), "logLevel", 1)));

    vector<shared_ptr<DNP3Connection>> loaded;
    auto cursor = connections.find(make_document(
        kvp("protocolDriver", ProtocolDriverName),
        kvp("protocolDriverInstanceNumber", ProtocolDriverInstanceNumber),
        kvp("enabled", true)));
    for (auto&& doc : cursor)
    {
        auto conn = make_shared<DNP3Connection>();
        conn->protocolDriverInstanceNumber = static_cast<int>(getDouble(doc, "protocolDriverInstanceNumber", 1));
        conn->protocolConnectionNumber = static_cast<int>(getDouble(doc, "protocolConnectionNumber", 1));
        conn->name = getString(doc, "name", "NO NAME");
        conn->enabled = getBool(doc, "enabled", true);
        conn->commandsEnabled = getBool(doc, "commandsEnabled", true);
        conn->connectionMode = upper(getString(doc, "connectionMode", "TCP ACTIVE"));
        conn->ipAddressLocalBind = getString(doc, "ipAddressLocalBind");
        conn->ipAddresses = getStringArray(doc, "ipAddresses");
        conn->portName = getString(doc, "portName");
        conn->baudRate = static_cast<int>(getDouble(doc, "baudRate", 9600));
        conn->parity = getString(doc, "parity", "None");
        conn->stopBits = getString(doc, "stopBits", "One");
        conn->handshake = getString(doc, "handshake", "None");
        conn->allowTLSv10 = getBool(doc, "allowTLSv10", false);
        conn->allowTLSv11 = getBool(doc, "allowTLSv11", false);
        conn->allowTLSv12 = getBool(doc, "allowTLSv12", true);
        conn->allowTLSv13 = getBool(doc, "allowTLSv13", true);
        conn->cipherList = getString(doc, "cipherList");
        conn->localCertFilePath = getString(doc, "localCertFilePath");
        conn->peerCertFilePath = getString(doc, "peerCertFilePath");
        conn->privateKeyFilePath = getString(doc, "privateKeyFilePath");
        conn->localLinkAddress = static_cast<int>(getDouble(doc, "localLinkAddress", 1));
        conn->remoteLinkAddress = static_cast<int>(getDouble(doc, "remoteLinkAddress", 1));
        conn->giInterval = static_cast<int>(getDouble(doc, "giInterval", 300));
        conn->class0ScanInterval = static_cast<int>(getDouble(doc, "class0ScanInterval", 0));
        conn->class1ScanInterval = static_cast<int>(getDouble(doc, "class1ScanInterval", 0));
        conn->class2ScanInterval = static_cast<int>(getDouble(doc, "class2ScanInterval", 0));
        conn->class3ScanInterval = static_cast<int>(getDouble(doc, "class3ScanInterval", 0));
        conn->rangeScans = getRangeScans(doc);
        conn->timeSyncMode = static_cast<int>(getDouble(doc, "timeSyncMode", 0));
        conn->enableUnsolicited = getBool(doc, "enableUnsolicited", true);
        loaded.push_back(conn);
    }
    if (loaded.empty())
        throw runtime_error("No DNP3 connections found");
    lock_guard<mutex> guard(ConnectionsMutex);
    DNP3conns = std::move(loaded);
}

} // namespace

int main(int argc, char* argv[])
{
    try
    {
        Log.log(DriverMessage);
        Log.log("Driver version " + DriverVersion);
        Log.log("Main: Starting driver...", Logger::Level::Detailed);

        bool cliLogLevelProvided = false;
        if (argc > 1)
            ProtocolDriverInstanceNumber = atoi(argv[1]);
        if (argc > 2)
        {
            int logLevel = atoi(argv[2]);
            Log.setLevel(logLevel);
            cliLogLevelProvided = true;
            Log.log("Main: Log level set to " + to_string(logLevel), Logger::Level::Detailed);
        }

        string configPath = argc > 3 ? argv[3] : JsonConfigFilePath;
        configPath = resolvePath(configPath);
        if (!fileExists(configPath))
            configPath = resolvePath(JsonConfigFilePathAlt);
        JSConfig = loadJsonConfig(configPath);
        if (JSConfig.mongoConnectionString.empty() || JSConfig.mongoDatabaseName.empty() || JSConfig.nodeName.empty())
            throw runtime_error("Invalid JSON-SCADA configuration");

        loadConnections(!cliLogLevelProvided);
        if (cliLogLevelProvided)
            Log.log("Main: Keeping CLI log level override after loading instance configuration.", Logger::Level::Detailed);
        else
            Log.log("Main: Effective log level loaded from instance configuration.", Logger::Level::Detailed);
        auto manager = make_shared<DNP3Manager>(2 * thread::hardware_concurrency(), ConsoleLogger::Create());
        auto dnp3LogLevel = mapLogLevel();

        Log.log("Main: Creating DNP3 channels...", Logger::Level::Detailed);
        for (const auto& conn : snapshotConnections())
        {
            conn->channel = createChannel(manager, conn, dnp3LogLevel);
            Log.log("Main: Channel created for " + conn->name, Logger::Level::Detailed);
            configureMaster(conn);
            Log.log(conn->name + " - Connection configured.");
        }
        Log.log("Main: All connections configured, starting threads...", Logger::Level::Detailed);

        Log.log("Main: Starting processMongo thread...");
        thread(processMongo).detach();
        Log.log("Main: Starting processMongoCmd thread...");
        thread(processMongoCmd).detach();
        Log.log("Main: Starting processRedundancy thread...");
        thread(processRedundancy).detach();
        Log.log("Main: All threads started, entering main loop...");

        Log.log("Main: Entering main loop...");
        int loopCount = 0;
        for (;;)
        {
            this_thread::sleep_for(chrono::milliseconds(500));
            loopCount++;
            if (loopCount % 120 == 0) // Every minute
                Log.log("Main: Still running...", Logger::Level::Detailed);
        }
    }
    catch (const exception& ex)
    {
        Log.log("Fatal error: " + string(ex.what()));
        return 1;
    }
}
