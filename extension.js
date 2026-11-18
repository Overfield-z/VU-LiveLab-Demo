// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { spawn } = require('child_process');

const QUESTION_VIEW_ID = 'my-first-vscode-extension.questionView';
const PYTHON_TIMEOUT_MS = 5000;
const MAX_OUTPUT_CHARS = 20000;
const TRACE_PREFIX = '@@VULIVELAB_TRACE@@';

const TASKS = [
	{
		title: 'ต่อท้าย List ด้วย mango',
		prompt: 'สร้าง List ชื่อ fruits ที่มี "apple" และ "banana" เพิ่ม "mango" ไว้ท้าย List แล้วพิมพ์สมาชิก index 2',
		hint: 'append() เพิ่มสมาชิกไว้ท้าย List และ index เริ่มนับจาก 0',
		expectedOutput: 'mango',
		traceRequirements: {
			variables: ['fruits'],
			initial: { fruits: ['apple', 'banana'] },
			afterLastLine: { fruits: ['apple', 'banana', 'mango'] },
			requiredCalls: [{ name: 'append', receiver: 'fruits' }]
		}
	},
	{
		title: 'แทรก green ใน List',
		prompt: 'สร้าง List ชื่อ colors ที่มี "red" และ "blue" แทรก "green" ที่ index 1 แล้วพิมพ์สมาชิก index 1',
		hint: 'insert(1, "green") จะแทรก green ก่อนสมาชิกเดิมที่อยู่ index 1',
		expectedOutput: 'green',
		traceRequirements: {
			variables: ['colors'],
			initial: { colors: ['red', 'blue'] },
			afterLastLine: { colors: ['red', 'green', 'blue'] },
			requiredCalls: [{ name: 'insert', receiver: 'colors' }]
		}
	}
];

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "my-first-vscode-extension" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with  registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('my-first-vscode-extension.helloWorld', function () {
		// The code you place here will be executed every time your command is executed

		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from my-first-vscode-extension!');
	});

	context.subscriptions.push(disposable);

	// Register the provider that fills the VU LiveLab view in the Explorer sidebar.
	const questionViewProvider = new QuestionViewProvider(context);
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => questionViewProvider.trackEditor(editor))
	);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(QUESTION_VIEW_ID, questionViewProvider)
	);
}

class QuestionViewProvider {
	constructor(context) {
		this.webviewView = undefined;
		this.taskIndex = 0;
		this.pythonFileUri = undefined;
		this.traceRunnerPath = context.asAbsolutePath(path.join('python', 'trace_runner.py'));
		this.trackEditor(vscode.window.activeTextEditor);
	}

	trackEditor(editor) {
		if (editor?.document.languageId === 'python' && editor.document.uri.scheme === 'file') {
			this.pythonFileUri = editor.document.uri;
			this.sendActiveFile();
		}
	}

	resolveWebviewView(webviewView) {
		this.webviewView = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((message) => {
			void this.handleMessage(message);
		});
	}

	async handleMessage(message) {
		if (message.type === 'ready') {
			this.sendTask();
			this.sendActiveFile();
		} else if (message.type === 'previousTask') {
			this.taskIndex = Math.max(0, this.taskIndex - 1);
			this.sendTask();
		} else if (message.type === 'nextTask') {
			this.taskIndex = Math.min(TASKS.length - 1, this.taskIndex + 1);
			this.sendTask();
		} else if (message.type === 'showHint') {
			this.postMessage({ type: 'hint', text: TASKS[this.taskIndex].hint });
		} else if (message.type === 'checkCode') {
			await this.checkCurrentCode(false);
		} else if (message.type === 'traceCode') {
			await this.checkCurrentCode(true);
		}
	}

	sendTask() {
		const task = TASKS[this.taskIndex];
		this.postMessage({
			type: 'task',
			index: this.taskIndex,
			total: TASKS.length,
			title: task.title,
			prompt: task.prompt
		});
	}

	sendActiveFile() {
		const fileName = this.pythonFileUri ? path.basename(this.pythonFileUri.fsPath) : '';
		this.postMessage({ type: 'activeFile', fileName });
	}

	postMessage(message) {
		this.webviewView?.webview.postMessage(message);
	}

	async checkCurrentCode(showTrace = false) {
		const task = TASKS[this.taskIndex];
		this.postMessage({ type: 'checking', traceMode: showTrace });

		try {
			if (!this.pythonFileUri) {
				throw new Error('กรุณาเปิดไฟล์ Python (.py) ก่อน แล้วค่อยกลับมากดตรวจโค้ด');
			}

			const document = await vscode.workspace.openTextDocument(this.pythonFileUri);
			if (!(await document.save())) {
				throw new Error('บันทึกไฟล์ไม่สำเร็จ กรุณาบันทึกไฟล์แล้วลองใหม่');
			}

			const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
			const result = await this.runPythonFile(
				document.uri.fsPath,
				workspaceFolder?.uri.fsPath ?? path.dirname(document.uri.fsPath),
				task.traceRequirements
			);
			const actualOutput = result.stdout.replace(/\r\n/g, '\n').trimEnd();
			const traceResult = this.checkTraceRequirements(result.traceEvents, task.traceRequirements);
			const passed = result.exitCode === 0
				&& actualOutput === task.expectedOutput
				&& traceResult.failures.length === 0;
			const details = [result.stderr, ...traceResult.failures].filter(Boolean).join('\n');
			this.postMessage({
				type: 'result',
				passed,
				output: actualOutput,
				detail: details,
				traceChecks: showTrace ? traceResult.checks : []
			});
		} catch (error) {
			this.postMessage({
				type: 'result',
				passed: false,
				output: '',
				detail: error instanceof Error ? error.message : String(error),
				traceEvents: []
			});
		}
	}

	checkTraceRequirements(events, requirements) {
		const snapshots = events.filter((event) => event.event === 'line' || event.event === 'return');
		const failures = [];
		const checks = [];

		for (const [name, expected] of Object.entries(requirements.initial)) {
			const firstSnapshot = snapshots.find((event) => Object.hasOwn(event.variables, name));
			const declaration = events.find((event) => event.event === 'variable-declaration' && event.name === name);
			if (!firstSnapshot) {
				const detail = `Trace ไม่พบตัวแปร "${name}" หลังประกาศ`;
				failures.push(detail);
				checks.push({
					title: `ค่าเริ่มต้นของ ${name}`,
					passed: false,
					detail,
					line: declaration?.line,
					source: declaration?.source || '',
					variables: {}
				});
			} else {
				const actual = firstSnapshot.variables[name];
				const passed = isDeepStrictEqual(actual, expected);
				const detail = passed ? 'ค่าตรงตามโจทย์' : `คาดว่า ${JSON.stringify(expected)} แต่พบ ${JSON.stringify(actual)}`;
				if (!passed) failures.push(`ค่าเริ่มต้นของ "${name}" ไม่ตรง (${detail})`);
				checks.push({
					title: `ค่าเริ่มต้นของ ${name}`,
					passed,
					detail,
					line: declaration?.line ?? firstSnapshot.line,
					source: declaration?.source || firstSnapshot.source,
					variables: { [name]: actual }
				});
			}
		}

		const afterLastLine = [...events].reverse().find((event) => event.event === 'return' && event.scope === 'ไฟล์หลัก');
		for (const [name, expected] of Object.entries(requirements.afterLastLine)) {
			if (!afterLastLine || !Object.hasOwn(afterLastLine.variables, name)) {
				const detail = `Trace ไม่พบตัวแปร "${name}" หลังบรรทัดสุดท้าย`;
				failures.push(detail);
				checks.push({ title: `หลังบรรทัดสุดท้าย: ${name}`, passed: false, detail, variables: {} });
			} else {
				const actual = afterLastLine.variables[name];
				const passed = isDeepStrictEqual(actual, expected);
				const detail = passed ? 'ค่าตรงตามโจทย์' : `คาดว่า ${JSON.stringify(expected)} แต่พบ ${JSON.stringify(actual)}`;
				if (!passed) failures.push(`ค่าของ "${name}" หลังบรรทัดสุดท้ายไม่ตรง (${detail})`);
				checks.push({
					title: `หลังบรรทัดสุดท้าย: ${name}`,
					passed,
					detail,
					line: afterLastLine.line,
					source: afterLastLine.source,
					variables: { [name]: actual }
				});
			}
		}

		for (const requiredCall of requirements.requiredCalls) {
			const found = events.find((event) => event.event === 'required-call'
				&& event.name === requiredCall.name
				&& event.receiver === requiredCall.receiver);
			const passed = Boolean(found?.found);
			const detail = passed
				? `พบการเรียก ${requiredCall.receiver}.${requiredCall.name}()`
				: `ไม่พบการเรียก ${requiredCall.receiver}.${requiredCall.name}()`;
			if (!passed) failures.push(detail);
			checks.push({
				title: `ตรวจการเรียก ${requiredCall.name}()`,
				passed,
				detail,
				line: found?.line,
				source: found?.source || ''
			});
		}
		return { checks, failures };
	}

	runPythonFile(filePath, cwd, traceRequirements) {
		const pythonCommand = vscode.workspace.getConfiguration('vuLiveLab').get('pythonCommand', 'python');

		return new Promise((resolve, reject) => {
			const args = [this.traceRunnerPath, filePath, JSON.stringify(traceRequirements)];
			const child = spawn(pythonCommand, args, { cwd, windowsHide: true });
			let stdout = '';
			let stderr = '';
			let traceBuffer = '';
			const traceEvents = [];
			let timedOut = false;
			let outputLimitReached = false;
			let settled = false;

			const timeout = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, PYTHON_TIMEOUT_MS);

			const collect = (stream, readOutput, writeOutput) => {
				stream.setEncoding('utf8');
				stream.on('data', (chunk) => {
					const current = readOutput();
					const remaining = MAX_OUTPUT_CHARS - current.length;
					writeOutput(current + chunk.slice(0, Math.max(0, remaining)));
					if (chunk.length > remaining) {
						outputLimitReached = true;
						child.kill();
					}
				});
			};

			collect(child.stdout, () => stdout, (value) => { stdout = value; });
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk) => {
				traceBuffer += chunk;
				const lines = traceBuffer.split(/\r?\n/);
				traceBuffer = lines.pop() ?? '';
				for (const line of lines) {
					if (line.startsWith(TRACE_PREFIX)) {
						try {
							traceEvents.push(JSON.parse(line.slice(TRACE_PREFIX.length)));
						} catch {
							// Ignore malformed trace records and preserve normal program output.
						}
					} else {
						const remaining = MAX_OUTPUT_CHARS - stderr.length;
						stderr += line.slice(0, Math.max(0, remaining)) + '\n';
						if (line.length > remaining) {
							outputLimitReached = true;
							child.kill();
						}
					}
				}
			});
			child.stderr.on('end', () => {
				if (traceBuffer) {
					if (traceBuffer.startsWith(TRACE_PREFIX)) {
						try {
							traceEvents.push(JSON.parse(traceBuffer.slice(TRACE_PREFIX.length)));
						} catch {
							// Ignore malformed trace records.
						}
					} else {
						const remaining = MAX_OUTPUT_CHARS - stderr.length;
						stderr += traceBuffer.slice(0, Math.max(0, remaining));
						if (traceBuffer.length > remaining) {
							outputLimitReached = true;
							child.kill();
						}
					}
				}
			});

			child.on('error', (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(new Error(`เปิด Python ไม่ได้ (${pythonCommand}): ${error.message}`));
			});

			child.on('close', (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);

				if (timedOut) {
					reject(new Error('โปรแกรมใช้เวลานานเกิน 5 วินาที จึงหยุดการทำงาน'));
				} else if (outputLimitReached) {
					reject(new Error('โปรแกรมแสดงผลมากเกินไป จึงหยุดการทำงาน'));
				} else {
					resolve({ stdout, stderr, traceEvents, exitCode: code });
				}
			});
		});
	}

	getHtml(webview) {
		const nonce = crypto.randomBytes(16).toString('base64');

		return `<!DOCTYPE html>
		<html lang="th">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
			<style>
				body {
					padding: 12px;
					color: var(--vscode-foreground);
					font-family: var(--vscode-font-family);
					font-size: var(--vscode-font-size);
				}
				.eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; }
				h2 { margin: 6px 0 12px; font-size: 18px; }
				.card {
					padding: 12px;
					border: 1px solid var(--vscode-panel-border);
					border-radius: 6px;
					background: var(--vscode-editor-background);
				}
				pre {
					padding: 10px;
					border-radius: 4px;
					background: var(--vscode-textCodeBlock-background);
					white-space: pre-wrap;
				}
				label { display: block; margin: 12px 0 6px; }
				input {
					box-sizing: border-box;
					width: 100%;
					padding: 7px;
					color: var(--vscode-input-foreground);
					background: var(--vscode-input-background);
					border: 1px solid var(--vscode-input-border, transparent);
					border-radius: 2px;
				}
				button {
					margin: 10px 6px 0 0;
					padding: 6px 10px;
					color: var(--vscode-button-foreground);
					background: var(--vscode-button-background);
					border: 0;
					border-radius: 2px;
					cursor: pointer;
				}
				button:hover { background: var(--vscode-button-hoverBackground); }
				button.secondary {
					color: var(--vscode-button-secondaryForeground);
					background: var(--vscode-button-secondaryBackground);
				}
				#result { min-height: 1.4em; margin-top: 12px; }
				#fileName { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 10px 0; }
				#result { white-space: pre-wrap; }
				#traceLog { max-height: 320px; overflow: auto; font-size: 11px; }
				.trace-event { padding: 8px 0; border-top: 1px solid var(--vscode-panel-border); }
				.trace-event code { color: var(--vscode-textLink-foreground); }
				.navigation { display: flex; justify-content: space-between; gap: 8px; }
				button:disabled { opacity: 0.5; cursor: default; }
			</style>
		</head>
		<body>
			<div class="eyebrow">VU LIVELAB · PYTHON LIST</div>
			<h2 id="taskTitle">กำลังโหลดโจทย์...</h2>
			<section class="card">
				<div id="progress" class="eyebrow"></div>
				<p id="prompt"></p>
				<p>เปิดไฟล์ Python (.py) ใน Editor แล้วกดตรวจโค้ด หรือดูผล Trace ของจุดตรวจ</p>
				<div id="fileName">ไฟล์ Python: ยังไม่ได้เลือก</div>
				<button id="check">ตรวจโค้ด</button>
				<button id="trace" class="secondary">Trace ทีละบรรทัด</button>
				<button id="hint" class="secondary">คำใบ้</button>
				<div id="result" role="status" aria-live="polite"></div>
				<details id="traceDetails" hidden>
					<summary>ดู 3 จุดตรวจของ Trace</summary>
					<div id="traceLog"></div>
				</details>
				<div class="navigation">
					<button id="previous" class="secondary">ข้อก่อนหน้า</button>
					<button id="next">ข้อถัดไป</button>
				</div>
			</section>
			<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();
				const result = document.getElementById('result');
				const traceDetails = document.getElementById('traceDetails');
				const traceLog = document.getElementById('traceLog');
				const send = (type) => vscode.postMessage({ type });
				document.getElementById('check').addEventListener('click', () => send('checkCode'));
				document.getElementById('trace').addEventListener('click', () => send('traceCode'));
				document.getElementById('hint').addEventListener('click', () => {
					send('showHint');
				});
				document.getElementById('previous').addEventListener('click', () => send('previousTask'));
				document.getElementById('next').addEventListener('click', () => send('nextTask'));
				window.addEventListener('message', (event) => {
					const message = event.data;
					if (message.type === 'task') {
						document.getElementById('taskTitle').textContent = message.title;
						document.getElementById('progress').textContent = 'โจทย์ ' + (message.index + 1) + ' / ' + message.total;
						document.getElementById('prompt').textContent = message.prompt;
						document.getElementById('previous').disabled = message.index === 0;
						document.getElementById('next').disabled = message.index === message.total - 1;
						result.textContent = '';
						traceDetails.hidden = true;
						traceLog.replaceChildren();
					} else if (message.type === 'activeFile') {
						document.getElementById('fileName').textContent = message.fileName
							? 'ไฟล์ Python: ' + message.fileName
							: 'ไฟล์ Python: ยังไม่ได้เปิดไฟล์ .py';
					} else if (message.type === 'checking') {
						result.textContent = message.traceMode
							? 'กำลังรัน Python และเก็บสถานะตัวแปร...'
							: 'กำลังบันทึกและรันไฟล์ Python...';
						traceDetails.hidden = true;
						traceLog.replaceChildren();
					} else if (message.type === 'result') {
						const output = message.output ? '\\nผลลัพธ์: ' + message.output : '';
						const detail = message.detail ? '\\n' + message.detail : '';
						result.textContent = (message.passed ? '✅ ผ่าน!' : '❌ ยังไม่ผ่าน') + output + detail;
						if (message.traceChecks?.length) {
							traceDetails.hidden = false;
							for (const item of message.traceChecks) {
								const row = document.createElement('div');
								row.className = 'trace-event';
								const label = document.createElement('strong');
								label.textContent = (item.passed ? '✅ ' : '❌ ') + item.title
									+ (item.line ? ' · บรรทัด ' + item.line : '');
								const source = document.createElement('div');
								const code = document.createElement('code');
								code.textContent = item.source || '(ไม่พบ source code ที่ตรงกับเกณฑ์)';
								source.appendChild(code);
								const detail = document.createElement('div');
								detail.textContent = item.detail;
								row.append(label, source, detail);
								if (item.variables && Object.keys(item.variables).length) {
									const state = document.createElement('pre');
									state.textContent = JSON.stringify(item.variables, null, 2);
									row.appendChild(state);
								}
								traceLog.appendChild(row);
							}
						}
					} else if (event.data.type === 'hint') {
						result.textContent = 'คำใบ้: ' + message.text;
					}
				});
				window.addEventListener('load', () => send('ready'));
			</script>
		</body>
		</html>`;
	}
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
