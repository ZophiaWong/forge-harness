#!/usr/bin/env node

import { runLivePortfolioDemo } from "./live.js";

const result = await runLivePortfolioDemo();
process.exitCode = result.status === "PASS" ? 0 : 1;
