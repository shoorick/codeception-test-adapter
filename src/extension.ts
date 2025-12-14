import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn } from 'child_process';

function discoverCodeceptionTests(
	controller: vscode.TestController,
	workspaceRoot: string
) {
	const testsRoot = path.join(workspaceRoot, 'tests');

	if (!fs.existsSync(testsRoot)) {
		return;
	}

	const suiteFiles = fs.readdirSync(testsRoot)
		.filter(f => f.endsWith('.suite.yml'));

	for (const suiteFile of suiteFiles) {
		const suiteName = suiteFile.replace('.suite.yml', '');
		const suiteDir = path.join(testsRoot, suiteName);

		const suiteItem = controller.createTestItem(
			`suite-${suiteName}`,
			suiteName,
			vscode.Uri.file(suiteDir)
		);

		controller.items.add(suiteItem);

		if (!fs.existsSync(suiteDir)) {
			continue;
		}

		const testFiles = fs.readdirSync(suiteDir)
			.filter(f => f.endsWith('Test.php') || f.endsWith('Cest.php'));

		for (const file of testFiles) {
			const filePath = path.join(suiteDir, file);

			const testItem = controller.createTestItem(
				`test-${suiteName}-${file}`,
				file,
				vscode.Uri.file(filePath)
			);

			suiteItem.children.add(testItem);
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	const controller = vscode.tests.createTestController(
		'codeception',
		'Codeception'
	);

	context.subscriptions.push(controller);

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (workspaceFolder) {
		discoverCodeceptionTests(controller, workspaceFolder.uri.fsPath);
	}

	controller.createRunProfile(
		'Run',
		vscode.TestRunProfileKind.Run,
		async (request, token) => {
			const run = controller.createTestRun(request);
			const queue: vscode.TestItem[] = [];

			if (request.include) {
				queue.push(...request.include);
			} else {
				controller.items.forEach(item => queue.push(item));
			}

			for (const item of queue) {
				if (token.isCancellationRequested) {
					break;
				}

				run.started(item);

				try {
					await runCodeceptionTest(item, run);
					run.passed(item);
				} catch (err) {
					run.failed(item, new vscode.TestMessage(String(err)));
				}
			}

			run.end();
		}
	);
}

async function runCodeceptionTest(
    item: vscode.TestItem,
    run: vscode.TestRun
): Promise<void> {
    const uri = item.uri;
    if (!uri) {
        return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
        run.appendOutput('No workspace folder found\n');
        return;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    const command = findCodeceptCommand(workspaceRoot);

    const filePath = uri.fsPath;
    const testsRoot = path.join(workspaceRoot, 'tests');

    let args: string[];

    if (filePath.endsWith('.php')) {
        // File-level run
        const relative = path.relative(testsRoot, filePath);
        const parts = relative.split(path.sep);

        const suite = parts[0];
        const file = parts.slice(1).join(path.sep);

        args = ['run', suite, file, '--ansi', '--no-interaction', '--xml'];
    } else {
        // Suite-level run
        const suite = path.basename(filePath);
        args = ['run', suite, '--ansi', '--no-interaction', '--xml'];
    }

    await execProcess(command, args, workspaceRoot, run);
}

function findCodeceptCommand(workspaceRoot: string): string {
    const local = path.join(workspaceRoot, 'vendor', 'bin', 'codecept');
    if (fs.existsSync(local)) {
        return local;
    }
    return 'codecept';
}

function execProcess(
    command: string,
    args: string[],
    cwd: string,
    run: vscode.TestRun
): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            cwd,
            shell: true,
            env: process.env
        });

        proc.stdout.on('data', data => {
            run.appendOutput(data.toString());
        });

        proc.stderr.on('data', data => {
            run.appendOutput(data.toString());
        });

        proc.on('exit', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Process exited with code ${code}`));
            }
        });
    });
}

export function deactivate() { }
