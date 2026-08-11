#!/usr/bin/env node

import { runLivePortfolioDemo } from "./live.js";

const result = await runLivePortfolioDemo();
console.log(`live.portfolio ${result.status} ${result.reason}`);
process.exitCode = result.status === "PASS" ? 0 : 1;
