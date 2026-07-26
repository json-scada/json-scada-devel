REM These are reference notes for building the C++ DNP3 drivers by hand.
REM On Windows prefer the runnable scripts in this folder, which need no manual
REM OpenSSL install (they build it with vcpkg):
REM     build-windows-deps.bat    one-time: OpenSSL, opendnp3, mongo-cxx-driver
REM     build-windows.bat         builds Dnp3ClientCpp (+ Dnp3Server with "server")

REM Requires https://slproweb.com/products/Win32OpenSSL.html (not the light package)
REM https://slproweb.com/download/Win64OpenSSL-3_4_0.msi

Windows MSVC
# git clone https://github.com/dnp3/opendnp3
cd opendnp3
mkdir build
cd build
cmake -DDNP3_EXAMPLES=ON -DDNP3_TLS=ON -DOPENSSL_ROOT_DIR="C:\Program Files\OpenSSL-Win64" -DOPENSSL_USE_STATIC_LIBS=TRUE -DOPENSSL_MSVC_STATIC_RT=TRUE ..

echo now run "msbuild opendnp3.sln /p:Configuration=Release" or open opendnp3.sln on Visual Studio.

cd ..\..\
cd Dnp3Server
mkdir build
cd build
cmake -DOPENSSL_ROOT_DIR="C:\Program Files\OpenSSL-Win64" -DOPENSSL_USE_STATIC_LIBS=TRUE -DOPENSSL_MSVC_STATIC_RT=TRUE ..
msbuild Dnp3Server.sln /p:Configuration=Release

MSYS2
cp asio.cmake opendnp3/deps/asio.cmake
cd opendnp3
rm -rf build
mkdir build
cd build
cmake -DDNP3_EXAMPLES=ON -DDNP3_TLS=ON -DOPENSSL_ROOT_DIR="d:/msys64/mingw64" -DOPENSSL_USE_STATIC_LIBS=TRUE ..
cmake --build . --config Release

cd ../../Dnp3Server
rm -rf build
mkdir build
cd build
cmake ..
cmake --build . --config Release
cp Dnp3Server.exe ../../../../bin/

cd ../../Dnp3ClientCpp
rm -rf build
mkdir build
cd build
cmake ..
cmake --build . --config Release
cp Dnp3ClientCpp.exe ../../../../bin/