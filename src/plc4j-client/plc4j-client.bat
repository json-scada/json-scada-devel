@echo off
rem {json:scada} PLC4J client launcher - requires a JRE/JDK 17+ (java in PATH or JAVA_HOME set)
rem args: [instance number] [log level] [config file name] [point filter]
set _JAVA=java
if defined JAVA_HOME set "_JAVA=%JAVA_HOME%\bin\java.exe"
"%_JAVA%" -Xms32m -Xmx512m -jar "%~dp0plc4j-client.jar" %*
