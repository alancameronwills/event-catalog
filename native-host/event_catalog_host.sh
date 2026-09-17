#!/bin/bash
# Chrome native-messaging host wrapper for macOS. Chrome can only launch an
# executable by path, so this just execs the actual host (host.mjs) with node
# from PATH. Nothing may be printed to stdout except node's framed output, so
# keep this quiet and let node inherit the stdin/stdout pipes.
exec node "$(dirname "${BASH_SOURCE[0]}")/host.mjs"
