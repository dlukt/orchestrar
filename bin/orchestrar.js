#!/usr/bin/env node
"use strict";

const path = require("node:path");

const orchestratorPath = path.join(__dirname, "..", "orchestrator.js");
require(orchestratorPath);
