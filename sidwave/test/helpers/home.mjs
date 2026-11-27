import os from "node:os";

/** The user's home: $HOME, else os.homedir() (Bun's os.homedir() does not follow $HOME). Same rule as homeDirectory() of c64bridge. */
export const homeDirectory = () => process.env.HOME || os.homedir();
