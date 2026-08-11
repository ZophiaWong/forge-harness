import { main } from "./demo.js";

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
