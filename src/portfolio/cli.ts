import { main } from "./demo.js";

const exitCode = await main();
process.exitCode = exitCode;

