import { projectHash } from "./paths";

const root = process.argv[2];
if (!root) process.exit(1);
process.stdout.write(projectHash(root));
