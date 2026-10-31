#!/bin/bash
# Delete the local test cluster and everything in it (its disposable data included).
export PATH="$HOME/.local/bin:$PATH"
kind delete cluster --name zerodrift
