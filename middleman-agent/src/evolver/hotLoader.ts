import * as ts from "typescript";
import * as vm from "vm";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { prisma } from "../lib/prisma";
import { validateCodeSafetyAST } from "./sandboxEnforcer";
import { GeneratedModule } from "./coderSubsystem";

// Maintain a live registry of loaded dynamic modules
const activeDynamicModules: Record<string, Function> = {};

/**
 * Dimension J - Hot Loader & Execution Engine
 * 
 * Takes the raw TypeScript output from Phase 2 (Coder), runs it through Phase 3 (Sandbox),
 * and if safe, dynamically transcodes the TS to JS in-memory.
 * Finally, injects the JS into an isolated V8 Virtual Machine context (`vm`)
 * to expose the 'execute' function securely to the Middleman Brain.
 */
export async function injectAndLoadModule(generated: GeneratedModule): Promise<boolean> {
    logger.info("hotloader_init", { module: generated.moduleName });

    try {
        // 1. Sandbox Verification
        validateCodeSafetyAST(generated.tsCode);
        logger.info("hotloader_sandbox_passed", { module: generated.moduleName });

        // 2. Transpile TS to JS in-memory
        const transpileResult = ts.transpileModule(generated.tsCode, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        });

        // 3. Create a strict V8 Virtual Machine sandbox
        // We do NOT expose process, global, fs, require, or console by default.
        const sandboxExports = {};
        const safeContext = vm.createContext({
            exports: sandboxExports,
            module: { exports: sandboxExports },
            // Give it safe math and date globals if needed
            Math: Math,
            Date: Date,
            // A local sandboxed logger so we can see output without compromising the native console
            console: {
                log: (...args: any[]) => logger.debug(`[DYNAMIC:${generated.moduleName}]`, ...args),
                error: (...args: any[]) => logger.error(`[DYNAMIC:${generated.moduleName}]`, ...args),
            }
        });

        // 4. Execute the code inside the VM
        const script = new vm.Script(transpileResult.outputText);
        script.runInContext(safeContext);

        // Extract the exported execute function
        const exportedModule = (safeContext.module as any).exports;
        if (typeof exportedModule.execute !== "function") {
            throw new Error("Generated module failed to export an 'execute' function.");
        }

        // 5. Store Live Reference
        activeDynamicModules[generated.moduleName] = exportedModule.execute;

        // 6. Persist code physically to DB and Backup File
        await persistModule(generated);

        logger.info("hotloader_activated", { module: generated.moduleName, status: "live" });
        return true;

    } catch (error: any) {
        logger.error("hotloader_failed", { module: generated.moduleName }, error);

        // Log the failure to the database so the Agent remembers what crashed
        await prisma.selfExtensionLog.create({
            data: {
                moduleName: generated.moduleName,
                purpose: "Failed Verification or Execution",
                codeSnapshot: generated.tsCode,
                status: "rolled_back",
                testResults: error.message
            }
        }).catch(() => { }); // ignore db write fails on error path

        return false;
    }
}

/**
 * Execute a dynamically loaded tool safely.
 */
export function runDynamicTool(moduleName: string, ...args: any[]): any {
    const fn = activeDynamicModules[moduleName];
    if (!fn) {
        throw new Error(`Dynamic tool ${moduleName} is not active or rolled back.`);
    }

    try {
        return fn(...args);
    } catch (err: any) {
        logger.error(`dynamic_tool_runtime_crash`, { moduleName }, err);
        // J6: Instant Rollback on runtime crash
        delete activeDynamicModules[moduleName];
        prisma.selfExtensionLog.update({
            where: { moduleName },
            data: { status: "rolled_back", testResults: err.message }
        }).catch(() => { });

        throw err;
    }
}

/**
 * Save physical files inside the internal directory if needed, and write to Prisma.
 */
async function persistModule(generated: GeneratedModule) {
    const dir = path.join(__dirname, "../../src/dynamic_modules");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Save physically for auditing
    fs.writeFileSync(path.join(dir, `${generated.moduleName}.ts`), generated.tsCode);
    fs.writeFileSync(path.join(dir, `${generated.moduleName}.test.ts`), generated.testCode);
    fs.writeFileSync(path.join(dir, `${generated.moduleName}.md`), generated.readme);

    // Save strictly to DB
    await prisma.selfExtensionLog.upsert({
        where: { moduleName: generated.moduleName },
        update: {
            codeSnapshot: generated.tsCode,
            status: "live",
            deployedAt: new Date()
        },
        create: {
            moduleName: generated.moduleName,
            purpose: "Dimension J Dynamic Tool",
            codeSnapshot: generated.tsCode,
            status: "live",
            deployedAt: new Date()
        }
    });
}
