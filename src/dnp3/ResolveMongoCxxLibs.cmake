# Resolves the static mongo-cxx-driver library for a given base name
# (e.g. "bsoncxx" or "mongocxx") into an output variable.
#
# The static libraries are installed as "<base_name>-static-<abi-tag>.lib",
# where <abi-tag> (e.g. "rts-x64-v145-md") depends on the MSVC toolset used
# to build mongo-cxx-driver, so it cannot be hardcoded in CMakeLists.txt.
# MONGO_LIB_DIR must be set by the caller before including this file.
function(resolve_mongocxx_lib out_var base_name)
    file(GLOB _matches "${MONGO_LIB_DIR}/${base_name}-static-*.lib")
    list(LENGTH _matches _count)
    if(_count EQUAL 0)
        message(FATAL_ERROR
            "Could not find ${base_name}-static-*.lib in ${MONGO_LIB_DIR}. "
            "Run build-windows-deps.bat to build mongo-cxx-driver.")
    elseif(_count GREATER 1)
        message(FATAL_ERROR
            "Multiple candidates for ${base_name}-static-*.lib in ${MONGO_LIB_DIR}: ${_matches}")
    endif()
    set(${out_var} "${_matches}" PARENT_SCOPE)
endfunction()
