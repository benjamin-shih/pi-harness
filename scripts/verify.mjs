import { runBehaviorSuite } from "./verify/behavior-suite.mjs";
import { runPackageStructureTests } from "./verify/package-structure.mjs";
import { runShellParserTests } from "./verify/shell-parser.mjs";
import { runSupportModuleTests } from "./verify/support-modules.mjs";

runPackageStructureTests();
runSupportModuleTests();
runShellParserTests();
await runBehaviorSuite();

if (process.exitCode) process.exit(process.exitCode);
console.log("verify ok");
