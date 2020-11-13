import fs from "fs"
import child_process, { ChildProcessWithoutNullStreams } from "child_process"
import { Writable, Readable } from "stream"

interface Stdio {
  stdout: string
  stderr: string
  status: number | null
}

/**
 * A wrapper around a process that can compile Sass files.
 */
export interface Compiler {
  /**
   * Run the compiler with the given args, at the path given as the cwd.
   */
  compile(path: string, args: string[]): Promise<Stdio>
}

/**
 * Returns a sass compiler that runs the given command.
 */
export function execCompiler(command: string): Compiler {
  return {
    async compile(path, args) {
      return child_process.spawnSync(command, args, {
        cwd: path,
        encoding: "utf-8",
        stdio: "pipe",
      })
    },
  }
}

/**
 * Create a child process that uses the dart-sass repo at the path,
 * and compiles the files input to stdin.
 */
async function createDartProcess(repoPath: string) {
  const dartFile = `
import "dart:convert";
import "dart:io";

import "${repoPath}/bin/sass.dart" as sass;

main() async {
  await for (var line in new LineSplitter().bind(utf8.decoder.bind(stdin))) {
    if (line.startsWith("!cd ")) {
      Directory.current = line.substring("!cd ".length);
      continue;
    }

    try {
      await sass.main(line.split(" ").where((arg) => arg.isNotEmpty).toList());
    } catch (error, stackTrace) {
      stderr.writeln("Unhandled exception:");
      stderr.writeln(error);
      stderr.writeln(stackTrace);
      exitCode = 255;
    }

    stdout.add([0xFF]);
    stdout.write(exitCode);
    stdout.add([0xFF]);
    stderr.add([0xFF]);
    exitCode = 0;
  }
}`
  const dartFilename = "/tmp/sass-wrapper.dart"
  await fs.promises.writeFile(dartFilename, dartFile, { encoding: "utf-8" })
  const child = child_process.spawn("dart", [
    "--enable-asserts",
    `--packages=${repoPath}/.packages`,
    dartFilename,
  ])
  // TODO figure out how to delete the file without crashing the process
  // fs.unlinkSync(dartFilename)
  // child.on("spawn", () => {
  //   fs.unlinkSync(dartFilename)
  // })
  return child
}

function splitSingle(buffer: Buffer, token: number) {
  const idx = buffer.indexOf(token)
  if (idx === -1) {
    return [buffer]
  } else {
    return [buffer.slice(0, idx), buffer.slice(idx + 1)]
  }
}

// Split a buffer using the given token
function split(buffer: Buffer, token: number) {
  const segments = []
  let [head, tail] = splitSingle(buffer, token)
  while (tail) {
    segments.push(head)
    const [head2, tail2] = splitSingle(tail, token)
    head = head2
    tail = tail2
  }
  segments.push(head)
  return segments
}

// Split the stream into chunks based on the break character (0xff)
// TODO need to test this
async function* toDartChunks(stream: Readable) {
  let buff = ""
  for await (const chunk of stream!) {
    const chunky: Buffer = chunk
    const [head, ...tail] = split(chunky, 0xff)
    // If we received *any* break characters, yield those segments
    if (tail.length > 0) {
      yield buff + head.toString()
      for (const item of tail.slice(0, tail.length - 1)) {
        yield item.toString()
      }
      // Set the buffer to the last unfinished segment
      buff = tail[tail.length - 1].toString()
    } else {
      // If we didn't receive any 0xff in this chunk, just append to the
      // intermediate buffer
      buff += head
    }
  }
}

export class DartCompiler implements Compiler {
  private stdin: Writable
  private stdout: AsyncGenerator<string>
  private stderr: AsyncGenerator<string>

  private constructor(dart: ChildProcessWithoutNullStreams) {
    this.stdin = dart.stdin
    this.stdout = toDartChunks(dart.stdout)
    this.stderr = toDartChunks(dart.stderr)
  }

  /**
   * Create a dart-sass compiler from the repo given by the path.
   */
  static async fromRepo(path: string) {
    return new DartCompiler(await createDartProcess(path))
  }

  async compile(path: string, opts: string[]) {
    this.stdin.write(`!cd ${path}\n`)
    this.stdin.write(opts.join(" ") + "\n")
    return {
      stdout: (await this.stdout.next()).value,
      stderr: (await this.stderr.next()).value,
      status: +(await this.stdout.next()).value,
    }
  }
}