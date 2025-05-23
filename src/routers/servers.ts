// Daemon: src/routers/servers.ts

import { Router } from "express";
import { WebSocketServer, WebSocket } from "ws";
import axios from "axios";
import * as fs_p from "fs/promises";
import fs from "fs";
import * as path from "path";
import { AppState, ServerState } from "../index";
import chalk from "chalk";

interface CargoFile {
  id: string;
  url: string;
  targetPath: string;
  properties: {
    hidden?: boolean;
    readonly?: boolean;
    noDelete?: boolean;
    customProperties?: Record<string, any>;
  };
}

interface ServerConfig {
  dockerImage: string;
  variables: Array<{
    name: string;
    description?: string;
    defaultValue: string;
    currentValue?: string;
    rules: string;
  }>;
  startupCommand: string;
  configFiles: Array<{
    path: string;
    content: string;
  }>;
  install: {
    dockerImage: string;
    entrypoint: string;
    script: string;
  };
  cargo?: CargoFile[]; // Cargo!
}

interface CreateServerRequest {
  serverId: string;
  validationToken: string;
  name: string;
  memoryLimit: number;
  cpuLimit: number;
  allocation: {
    bindAddress: string;
    port: number;
  };
}

interface UpdateServerRequest {
  serverId: string;
  name: string;
  memoryLimit: number;
  cpuLimit: number;
  allocation: {
    bindAddress: string;
    port: number;
  };
  unitChanged?: boolean;
  dockerImage?: string;
}

// Helper functions for server management
async function fetchServerConfig(
  appUrl: string,
  serverId: string,
): Promise<ServerConfig> {
  const url = `${appUrl}/api/servers/${serverId}/config`;
  const maxRetries = 3;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, { timeout: 10000 });
      if (response.status === 200) {
        return response.data;
      }
    } catch (error) {
      console.error(
        `Failed to fetch server configuration (attempt ${attempt}/${maxRetries}):`,
        error.message,
      );
      lastError = error;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw new Error(
    `Failed to fetch server configuration after ${maxRetries} attempts: ${lastError?.message}`,
  );
}

async function validateServerWithPanel(
  appUrl: string,
  serverId: string,
  validationToken: string,
): Promise<boolean> {
  try {
    const response = await axios.post(
      `${appUrl}/api/servers/${serverId}/validate/${validationToken}`,
      { timeout: 5000 },
    );
    return response.status === 200;
  } catch (error) {
    console.error("Failed to validate server with panel:", error);
    return false;
  }
}

async function writeConfigFiles(
  volumePath: string,
  configFiles: ServerConfig["configFiles"],
): Promise<void> {
  for (const file of configFiles) {
    const safePath = path.normalize(file.path).replace(/^(\.\.[\/\\])+/, "");
    const fullPath = path.join(volumePath, safePath);

    await fs_p.mkdir(path.dirname(fullPath), { recursive: true });

    try {
      await fs_p.writeFile(fullPath, file.content, "utf8");
      console.log(`Created config file: ${safePath}`);
    } catch (error) {
      console.error(`Failed to write config file ${safePath}:`, error);
      throw new Error(`Failed to write config file ${safePath}`);
    }
  }
}

async function downloadCargoFile(
  url: string,
  targetPath: string,
): Promise<void> {
  try {
    const response = await axios({
      method: "GET",
      url,
      responseType: "stream",
      timeout: 30000,
    });

    const writer = fs.createWriteStream(targetPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", () => resolve(void 0));
      writer.on("error", reject);
    });
  } catch (error) {
    throw new Error(`Failed to download cargo file: ${error.message}`);
  }
}

async function processCargoFiles(
  volumePath: string,
  cargo: CargoFile[],
  logger: InstallLogger,
): Promise<void> {
  for (const file of cargo) {
    const safePath = path
      .normalize(file.targetPath)
      .replace(/^(\.\.[\/\\])+/, "");
    const fullPath = path.join(volumePath, safePath);

    try {
      // Create directory structure
      await fs_p.mkdir(path.dirname(fullPath), { recursive: true });

      // Download the file
      logger.log(`Downloading cargo file to ${safePath}...`);
      await downloadCargoFile(file.url, fullPath);

      // Set file permissions based on properties
      if (file.properties.readonly) {
        await fs_p.chmod(fullPath, 0o444);
      }

      logger.log(`Successfully processed cargo file: ${safePath}`);
    } catch (error) {
      logger.log(`Failed to process cargo file ${safePath}`, error);
      throw error;
    }
  }
}

// Update the processVariables function to handle cargo syntax
function processVariables(
  input: string,
  variables: ServerConfig["variables"],
  cargo?: CargoFile[],
): string {
  let result = input;

  // Process standard variables first
  for (const variable of variables) {
    const placeholder = `%${variable.name.toLowerCase().replace(/ /g, "_")}%`;
    const value = variable.currentValue ?? variable.defaultValue;

    if (!validateVariableValue(value, variable.rules)) {
      throw new Error(
        `Variable ${variable.name} value doesn't match rules: ${variable.rules}`,
      );
    }

    result = result.replace(placeholder, value);
  }

  // Process cargo variables if they exist
  if (cargo) {
    const cargoRegex = /%cargo:\['([^']+)'\]%/g;
    result = result.replace(cargoRegex, (match, path) => {
      const cargoFile = cargo.find((c) => c.targetPath === path);
      if (!cargoFile) {
        throw new Error(`Referenced cargo file not found: ${path}`);
      }
      return path;
    });
  }

  return result;
}

function validateVariableValue(value: string, rules: string): boolean {
  const ruleList = rules.split("|");

  for (const rule of ruleList) {
    switch (true) {
      case rule === "nullable":
        if (value === "") return true;
        break;
      case rule === "string":
        break;
      case rule.startsWith("max:"):
        const max = parseInt(rule.slice(4), 10);
        if (!isNaN(max) && value.length > max) return false;
        break;
    }
  }

  return true;
}

async function pullDockerImage(docker: any, image: string): Promise<void> {
  try {
    console.log(`Pulling Docker image: ${image}`);
    await new Promise((resolve, reject) => {
      docker.pull(image, (err: any, stream: any) => {
        if (err) return reject(err);

        docker.modem.followProgress(stream, (err: any, output: any) => {
          if (err) return reject(err);
          resolve(output);
        });
      });
    });
  } catch (error) {
    console.error(`Failed to pull Docker image ${image}:`, error);
    throw new Error(`Failed to pull Docker image ${image}`);
  }
}

function sanitizeVolumeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function logEvent(serverId: string, message: string, error?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [Server ${serverId}] ${message}`;
  console.log(logMessage);
  if (error) {
    console.error(`${logMessage} Error:`, error);
  }
}

class InstallLogger {
  private serverId: string;
  private wsServer: WebSocketServer; // Use WebSocketServer type
  private logBuffer: string[] = [];

  constructor(serverId: string, wsServer: WebSocketServer) {
    this.serverId = serverId;
    this.wsServer = wsServer;
  }

  log(message: string, error?: any) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] ${message}`;
    this.logBuffer.push(formattedMessage);

    console.log(`[Server ${this.serverId}] ${message}`);
    if (error) {
      console.error(`[Server ${this.serverId}] Error:`, error);
    }

    // Broadcast to WebSocket clients
    this.broadcast(message, error);
  }

  getLogBuffer(): string[] {
    return this.logBuffer;
  }

  private broadcast(message: string, error?: any) {
    this.wsServer.clients.forEach((client: WebSocket) => {
      // Use WebSocket type for client
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            event: "console_output",
            data: {
              message: error ? chalk.red(message) : message,
              timestamp: new Date().toISOString(),
              type: error ? "error" : "info",
            },
          }),
        );
      }
    });
  }
}

export async function runInstallation(
  appState: AppState,
  serverId: string,
  serverConfig: ServerConfig,
  memoryLimit: number,
): Promise<void> {
  console.log("RUNNING INSTALLATION!!!!");

  const logger = new InstallLogger(serverId, appState.wsServer);
  const { docker, config } = appState;
  const safeServerId = serverId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const volumePath = path.resolve(`${config.volumesDirectory}/${safeServerId}`);

  await fs_p.mkdir(volumePath, { recursive: true, mode: 0o777 });
  await fs_p.chmod(volumePath, 0o777);

  const installationPath = path.join(volumePath, ".installation");
  await fs_p.mkdir(installationPath, { recursive: true, mode: 0o777 });
  await fs_p.chmod(installationPath, 0o777);

  try {
    logger.log("Creating installation environment...");
    await prepareInstallationEnvironment(
      installationPath,
      serverConfig,
      logger,
    );

    logger.log("Pulling required Docker images...");
    await pullRequiredImages(docker, serverConfig, logger);

    logger.log("Preparing installation script...");
    const scriptPath = await writeInstallationScript(
      installationPath,
      serverConfig,
      logger,
    );

    logger.log("Starting installation container...");
    const containerId = await runInstallationContainer(
      docker,
      safeServerId,
      serverConfig,
      volumePath,
      scriptPath,
      memoryLimit,
      logger,
    );

    await monitorInstallation(docker, containerId, logger);

    logger.log("Installation completed successfully");

    await fs_p.rm(installationPath, { recursive: true, force: true });
  } catch (error) {
    logger.log("Installation failed", error);

    const logPath = path.join(volumePath, "installation.log");
    await fs_p.writeFile(logPath, logger.getLogBuffer().join("\n"));
    throw error;
  }
}

async function prepareInstallationEnvironment(
  installPath: string,
  config: ServerConfig,
  logger: InstallLogger,
): Promise<void> {
  await fs_p.mkdir(path.join(installPath, "logs"), {
    recursive: true,
    mode: 0o777,
  });
  await fs_p.mkdir(path.join(installPath, "temp"), {
    recursive: true,
    mode: 0o777,
  });

  await fs_p.chmod(installPath, 0o777);

  const volumePath = path.dirname(installPath);
  await fs_p.chmod(volumePath, 0o777);

  for (const file of config.configFiles) {
    const safePath = path.normalize(file.path).replace(/^(\.\.[\/\\])+/, "");
    const fullPath = path.join(installPath, "config", safePath);

    await fs_p.mkdir(path.dirname(fullPath), { recursive: true, mode: 0o777 });
    await fs_p.writeFile(fullPath, file.content, "utf8");
    await fs_p.chmod(fullPath, 0o666);
    logger.log(`Created config file: ${safePath}`);
  }

  if (config.cargo && config.cargo.length > 0) {
    logger.log("Processing cargo files...");
    await processCargoFiles(installPath, config.cargo, logger);
  }
}

async function pullRequiredImages(
  docker: any,
  config: ServerConfig,
  logger: InstallLogger,
): Promise<void> {
  const images = [config.install.dockerImage, config.dockerImage];

  for (const image of images) {
    logger.log(`Pulling image: ${image}`);
    try {
      await new Promise((resolve, reject) => {
        docker.pull(image, (err: any, stream: any) => {
          if (err) return reject(err);

          docker.modem.followProgress(
            stream,
            (err: any, output: any) => (err ? reject(err) : resolve(output)),
            (event: any) => {
              if (event.status && event.progress) {
                logger.log(`${image}: ${event.status} ${event.progress}`);
              }
            },
          );
        });
      });
      logger.log(`Successfully pulled ${image}`);
    } catch (error) {
      throw new Error(`Failed to pull ${image}: ${error.message}`);
    }
  }
}

async function writeInstallationScript(
  installPath: string,
  config: ServerConfig,
  logger: InstallLogger,
): Promise<string> {
  const currentDate = new Date().toISOString();

  const logsDir = path.join(installPath, "logs");
  await fs_p.mkdir(logsDir, { recursive: true, mode: 0o777 });
  await fs_p.chmod(logsDir, 0o777);

  const logFile = path.join(logsDir, "install.log");
  await fs_p.writeFile(logFile, "", { mode: 0o666 });
  await fs_p.chmod(logFile, 0o666);

  const scriptContent = `#!/bin/bash
set -e

exec 1> >(tee -a "/mnt/server/.installation/logs/install.log")
exec 2>&1

echo "=== Installation Started at ${currentDate} ==="
echo "Setting up environment..."

trap 'echo "Error on line $LINENO" >> /mnt/server/.installation/logs/install.log' ERR

${config.variables
  .map((v) => `export ${v.name}="${v.currentValue || v.defaultValue}"`)
  .join("\n")}

echo "Running main installation script..."
${config.install.script}

EXIT_CODE=$?

echo "=== Installation Finished at \$(date -u +"%Y-%m-%dT%H:%M:%SZ") with exit code $EXIT_CODE ==="
exit $EXIT_CODE`;

  const scriptPath = path.join(installPath, "install.sh");
  await fs_p.writeFile(scriptPath, scriptContent, { mode: 0o755 });
  await fs_p.chmod(scriptPath, 0o755);

  return scriptPath;
}

async function runInstallationContainer(
  docker: any,
  safeServerId: string,
  config: ServerConfig,
  volumePath: string,
  scriptPath: string,
  memoryLimit: number,
  logger: InstallLogger,
): Promise<string> {
  await fs_p.chmod(volumePath, 0o777);

  const container = await docker.createContainer({
    name: `${safeServerId}_install`,
    Image: config.install.dockerImage,
    HostConfig: {
      Binds: [`${volumePath}:/mnt/server:rw`],
      Memory: memoryLimit,
      MemorySwap: memoryLimit * 2,
      AutoRemove: true,
      NetworkMode: "host",
      Privileged: true,
    },
    WorkingDir: "/mnt/server",
    Cmd: ["bash", "/mnt/server/.installation/install.sh"],
    Env: [
      "DEBIAN_FRONTEND=nointeractive",
      ...config.variables.map(
        (v) => `${v.name}=${v.currentValue || v.defaultValue}`,
      ),
    ],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    OpenStdin: true,
    User: "root",
  });

  logger.log(`Created installation container: ${safeServerId}_install`);
  logger.log(`Mount: ${volumePath} -> /mnt/server`);
  logger.log(`Script path: /mnt/server/.installation/install.sh`);

  const stream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  const handleOutput = (chunk: Buffer) => {
    const message = chunk.toString().trim();
    if (message) {
      logger.log(message);
    }
  };

  stream.on("data", handleOutput);
  stream.on("error", (error: Error) => logger.log("Stream error:", error));

  await container.start();
  return container.id;
}

async function monitorInstallation(
  docker: any,
  containerId: string,
  logger: InstallLogger,
): Promise<void> {
  const container = docker.getContainer(containerId);

  // Wait for container to finish
  const result = await container.wait();

  if (result.StatusCode !== 0) {
    // Read logs from the installation log file
    try {
      const logs = await container.logs({
        stdout: true,
        stderr: true,
        tail: 50,
      });
      throw new Error(
        `Installation failed with exit code ${result.StatusCode}\nLast 50 lines of logs:\n${logs}`,
      );
    } catch (error) {
      throw new Error(
        `Installation failed with exit code ${result.StatusCode}`,
      );
    }
  }
}

async function createGameContainer(
  appState: AppState,
  serverId: string,
  config: ServerConfig,
  memoryLimit: number,
  cpuLimit: number,
  allocation: { bindAddress: string; port: number },
): Promise<string> {
  const { docker } = appState;
  const safeServerId = sanitizeVolumeName(serverId);
  const volumePath = path.resolve(
    `${appState.config.volumesDirectory}/${safeServerId}`,
  );

  await fs_p.chmod(volumePath, 0o777);

  const processedStartupCommand = processVariables(
    config.startupCommand,
    config.variables,
  );

  const environmentVariables = [
    "TERM=xterm",
    "HOME=/home/container",
    "USER=container",
    `STARTUP=${processedStartupCommand}`,
    ...config.variables.map(
      (variable) =>
        `${variable.name}=${variable.currentValue || variable.defaultValue}`,
    ),
  ];

  const container = await docker.createContainer({
    name: safeServerId,
    Image: config.dockerImage,

    Entrypoint: undefined,
    Cmd: undefined,

    WorkingDir: "/home/container",
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    Tty: false,
    StdinOnce: false,
    User: "container",

    Env: environmentVariables,

    HostConfig: {
      Memory: memoryLimit,
      MemorySwap: memoryLimit * 2,

      CpuQuota: cpuLimit ? cpuLimit * 100000 : 0,
      CpuPeriod: 100000,

      NetworkMode: "bridge",

      Privileged: true,

      Init: true,
      SecurityOpt: ["no-new-privileges"],
      ReadonlyPaths: [
        "/proc/bus",
        "/proc/fs",
        "/proc/irq",
        "/proc/sys",
        "/proc/sysrq-trigger",
      ],

      RestartPolicy: {
        Name: "unless-stopped",
      },

      Binds: [`${volumePath}:/home/container:rw`],

      PortBindings: {
        [`${allocation.port}/tcp`]: [
          {
            HostIp: allocation.bindAddress,
            HostPort: allocation.port.toString(),
          },
        ],
        [`${allocation.port}/udp`]: [
          {
            HostIp: allocation.bindAddress,
            HostPort: allocation.port.toString(),
          },
        ],
      },
    },

    ExposedPorts: {
      [`${allocation.port}/tcp`]: {},
      [`${allocation.port}/udp`]: {},
    },

    Labels: {
      "pterodactyl.server.id": serverId,
      "pterodactyl.server.name": safeServerId,
    },
  });

  return container.id;
}

async function recreateGameContainer(
  appState: AppState,
  serverId: string,
  updateData: UpdateServerRequest,
  currentDockerId?: string,
): Promise<string> {
  const { docker } = appState;
  const safeServerId = sanitizeVolumeName(serverId);
  const volumePath = path.resolve(
    `${appState.config.volumesDirectory}/${safeServerId}`,
  );

  // Fetch the latest server config if unit changed
  let serverConfig: ServerConfig;
  if (updateData.unitChanged) {
    serverConfig = await fetchServerConfig(appState.config.appUrl, serverId);
  } else {
    // Get current configuration from the database
    const dbServer = await appState.db.get(
      "SELECT * FROM servers WHERE id = ?",
      [serverId],
    );
    serverConfig = {
      dockerImage: updateData.dockerImage || dbServer.image,
      variables: JSON.parse(dbServer.variables),
      startupCommand: dbServer.startup_command,
      configFiles: [], // We don't need these for recreation
      install: JSON.parse(dbServer.install_script),
    };
  }

  // Process the startup command with variables
  const processedStartupCommand = processVariables(
    serverConfig.startupCommand,
    serverConfig.variables,
  );

  // Pull new image if unit/image changed
  if (updateData.unitChanged && updateData.dockerImage) {
    try {
      await pullDockerImage(docker, updateData.dockerImage);
    } catch (error) {
      console.error(`Failed to pull new Docker image: ${error.message}`);
      throw new Error(`Failed to pull new Docker image: ${error.message}`);
    }
  }

  // Stop and remove existing container if it exists
  if (currentDockerId) {
    try {
      const container = docker.getContainer(currentDockerId);
      const containerInfo = await container.inspect();

      // Only stop if running
      if (containerInfo.State.Running) {
        await container.stop({ t: 10 }); // 10 second timeout
      }

      // Remove the container but keep volumes
      await container.remove();
      logEvent(serverId, "Removed old container for update");
    } catch (error) {
      console.error("Failed to remove existing container:", error);
      logEvent(serverId, "Failed to remove old container for update", error);
      // Continue with recreation even if removal fails
    }
  }

  // Prepare environment variables
  const environmentVariables = [
    "TERM=xterm",
    "HOME=/home/container",
    "USER=container",
    `STARTUP=${processedStartupCommand}`,
    ...serverConfig.variables.map(
      (variable) =>
        `${variable.name}=${variable.currentValue || variable.defaultValue}`,
    ),
  ];

  // Create new container with updated settings
  const container = await docker.createContainer({
    name: safeServerId,
    Image: serverConfig.dockerImage,

    Entrypoint: undefined,
    Cmd: undefined,

    WorkingDir: "/home/container",
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    Tty: false,
    StdinOnce: false,
    User: "container",

    Env: environmentVariables,

    HostConfig: {
      Memory: updateData.memoryLimit,
      MemorySwap: updateData.memoryLimit * 2,

      CpuQuota: updateData.cpuLimit ? updateData.cpuLimit * 100000 : 0,
      CpuPeriod: 100000,

      NetworkMode: "bridge",

      Init: true,
      SecurityOpt: ["no-new-privileges"],
      ReadonlyPaths: [
        "/proc/bus",
        "/proc/fs",
        "/proc/irq",
        "/proc/sys",
        "/proc/sysrq-trigger",
      ],

      RestartPolicy: {
        Name: "unless-stopped",
      },

      Binds: [`${volumePath}:/home/container:rw`],

      PortBindings: {
        [`${updateData.allocation.port}/tcp`]: [
          {
            HostIp: updateData.allocation.bindAddress,
            HostPort: updateData.allocation.port.toString(),
          },
        ],
        [`${updateData.allocation.port}/udp`]: [
          {
            HostIp: updateData.allocation.bindAddress,
            HostPort: updateData.allocation.port.toString(),
          },
        ],
      },
    },

    ExposedPorts: {
      [`${updateData.allocation.port}/tcp`]: {},
      [`${updateData.allocation.port}/udp`]: {},
    },

    Labels: {
      "pterodactyl.server.id": serverId,
      "pterodactyl.server.name": safeServerId,
    },
  });

  // Start the new container
  await container.start();

  // Update the database with new container ID and image
  await appState.db.run(
    "UPDATE servers SET docker_id = ?, state = ?, name = ?, memory_limit = ?, cpu_limit = ?, image = ? WHERE id = ?",
    [
      container.id,
      ServerState.Running,
      updateData.name,
      updateData.memoryLimit,
      updateData.cpuLimit,
      updateData.unitChanged && updateData.dockerImage
        ? updateData.dockerImage
        : serverConfig.dockerImage,
      serverId,
    ],
  );

  return container.id;
}

// Router
export function configureServersRouter(appState: AppState): Router {
  const router = Router();

  // Create server
  router.post("/", async (req, res) => {
    try {
      const {
        serverId,
        validationToken,
        name,
        memoryLimit,
        cpuLimit,
        allocation,
      } = req.body as CreateServerRequest;

      // Get server configuration from panel
      const serverConfig = await fetchServerConfig(
        appState.config.appUrl,
        serverId,
      );

      // Create initial database entry
      await appState.db.run(
        `INSERT INTO servers (
          id, docker_id, name, state, memory_limit, cpu_limit, image,
          variables, startup_command, install_script, allocation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          serverId,
          null,
          name,
          ServerState.Installing,
          memoryLimit,
          cpuLimit,
          serverConfig.dockerImage,
          JSON.stringify(serverConfig.variables),
          serverConfig.startupCommand,
          JSON.stringify(serverConfig.install),
          JSON.stringify(allocation),
        ],
      );

      // Return success with validation token to confirm identity
      res.status(201).json({
        id: serverId,
        name,
        state: ServerState.Installing,
        validationToken,
      });

      // Begin installation process
      runInstallation(appState, serverId, serverConfig, memoryLimit)
        .then(async () => {
          const dockerId = await createGameContainer(
            appState,
            serverId,
            serverConfig,
            memoryLimit,
            cpuLimit,
            allocation,
          );

          // Start the container before installing MySQL client
          try {
            const container = appState.docker.getContainer(dockerId);
            await container.start();
            console.log(`[Server ${serverId}] Container started successfully`);

            // Install MySQL client for database access
            console.log(
              `[Server ${serverId}] Installing MySQL client for database access...`,
            );
            const exec = await container.exec({
              Cmd: [
                "bash",
                "-c",
                "apt-get update && apt-get install -y default-mysql-client mariadb-server && " +
                  "systemctl enable mariadb && " +
                  "systemctl start mariadb && " +
                  "mysql -u root -e \"ALTER USER 'root'@'localhost' IDENTIFIED BY 'rootpassword';\" && " +
                  "mysql -u root -prootpassword -e \"GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' IDENTIFIED BY 'rootpassword';\" && " +
                  'mysql -u root -prootpassword -e "FLUSH PRIVILEGES;" && ' +
                  "systemctl restart mariadb",
              ],
              AttachStdout: true,
              AttachStderr: true,
              User: "root",
            });

            await new Promise((resolve, reject) => {
              exec.start({}, (err, stream) => {
                if (err) {
                  console.error(
                    `[Server ${serverId}] Failed to start MySQL client installation:`,
                    err,
                  );
                  return resolve(void 0); // Continue despite error
                }
                if (!stream) {
                  console.error(
                    `[Server ${serverId}] No stream returned from exec`,
                  );
                  return resolve(void 0); // Continue despite error
                }

                // Capture output for logging
                const chunks: Buffer[] = [];
                stream.on("data", (chunk) => chunks.push(chunk));
                stream.on("end", () => {
                  const output = Buffer.concat(chunks).toString();
                  console.log(
                    `[Server ${serverId}] MySQL client installation output: ${output}`,
                  );
                  resolve(void 0);
                });
                stream.on("error", (err) => {
                  console.error(
                    `[Server ${serverId}] Stream error during MySQL client installation:`,
                    err,
                  );
                  resolve(void 0); // Continue despite error
                });
              });
            });

            console.log(
              `[Server ${serverId}] MySQL client installation completed successfully`,
            );
          } catch (error) {
            console.error(
              `[Server ${serverId}] Failed to start container or install MySQL client:`,
              error,
            );
            // Don't fail the entire server creation if just the MySQL client installation fails
            appState.wsServer.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(
                  JSON.stringify({
                    event: "console_output",
                    data: {
                      message: `${chalk.red("[Krypton Daemon]")} Warning: Failed to install MySQL client: ${error.message}`,
                    },
                  }),
                );
              }
            });
            // Continue with server creation even if MySQL client installation fails
          }

          await appState.db.run(
            "UPDATE servers SET docker_id = ?, state = ? WHERE id = ?",
            [dockerId, ServerState.Running, serverId],
          );

          appState.wsServer.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  event: "console_output",
                  data: {
                    message: `${chalk.yellow("[Krypton Daemon]")} Server installation completed successfully!`,
                  },
                }),
              );
            }
          });
        })
        .catch(async (error) => {
          console.error("Installation failed:", error);
          await appState.db.run("UPDATE servers SET state = ? WHERE id = ?", [
            ServerState.InstallFailed,
            serverId,
          ]);
        });
    } catch (error) {
      console.error("Failed to create server:", error);
      res.status(500).json({ error: error.message });
    }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const updateData = req.body as UpdateServerRequest;

      // Validate request data
      if (!updateData.serverId || updateData.serverId !== id) {
        return res
          .status(400)
          .json({ error: "Invalid server ID in request data" });
      }

      // Get the current server data
      const server = await appState.db.get(
        "SELECT docker_id, image FROM servers WHERE id = ?",
        [id],
      );

      if (!server) {
        return res.status(404).json({ error: "Server not found" });
      }

      // Update server state to indicate it's being modified
      await appState.db.run("UPDATE servers SET state = ? WHERE id = ?", [
        ServerState.Updating,
        id,
      ]);

      // Recreate the container with updated settings
      const newDockerId = await recreateGameContainer(
        appState,
        id,
        updateData,
        server.docker_id,
      );

      // Start the new container
      const container = appState.docker.getContainer(newDockerId);
      await container.start();

      // Update the database with new container ID and image
      await appState.db.run(
        "UPDATE servers SET docker_id = ?, state = ?, name = ?, memory_limit = ?, cpu_limit = ?, image = ? WHERE id = ?",
        [
          newDockerId,
          ServerState.Running,
          updateData.name,
          updateData.memoryLimit,
          updateData.cpuLimit,
          updateData.unitChanged && updateData.dockerImage
            ? updateData.dockerImage
            : server.image,
          id,
        ],
      );

      // Get updated server info
      const updatedServer = await appState.db.get(
        "SELECT * FROM servers WHERE id = ?",
        [id],
      );

      res.json({
        message: "Server updated successfully",
        server: updatedServer,
      });
    } catch (error) {
      console.error("Failed to update server:", error);

      // Update state to indicate failure
      await appState.db.run("UPDATE servers SET state = ? WHERE id = ?", [
        ServerState.UpdateFailed,
        req.params.id,
      ]);

      res.status(500).json({ error: error.message });
    }
  });

  // Get all servers
  router.get("/", async (req, res) => {
    try {
      const servers = await appState.db.all("SELECT * FROM servers");
      res.json(servers);
    } catch (error) {
      console.error("Failed to get servers:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get specific server
  router.get("/:id", async (req, res) => {
    try {
      const server = await appState.db.get(
        "SELECT * FROM servers WHERE id = ?",
        [req.params.id],
      );

      if (!server) {
        return res.status(404).json({ error: "Server not found" });
      }

      // Get container status if available
      if (server.docker_id) {
        try {
          const container = appState.docker.getContainer(server.docker_id);
          const status = await container.inspect();
          server.status = {
            state: status.State.Status,
            running: status.State.Running,
            startedAt: status.State.StartedAt,
            finishedAt: status.State.FinishedAt,
          };
        } catch (error) {
          console.error("Failed to get container status:", error);
          server.status = { state: "unknown" };
        }
      }

      res.json(server);
    } catch (error) {
      console.error("Failed to get server:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Delete server
  router.delete("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const safeId = sanitizeVolumeName(id);
      const server = await appState.db.get(
        "SELECT docker_id FROM servers WHERE id = ?",
        [id],
      );

      if (!server) {
        return res.status(404).json({ error: "Server not found" });
      }

      // Remove container if it exists
      if (server.docker_id) {
        try {
          const container = appState.docker.getContainer(server.docker_id);
          await container.remove({ force: true, v: true });
          logEvent(id, "Removed container");
        } catch (error) {
          console.error("Failed to remove container:", error);
          logEvent(id, "Failed to remove container", error);
        }
      }

      // Remove volume directory
      const volumePath = `${appState.config.volumesDirectory}/${safeId}`;
      await fs_p.rm(volumePath, { recursive: true, force: true });
      logEvent(id, "Removed volume directory");

      // Remove from database
      await appState.db.run("DELETE FROM servers WHERE id = ?", [id]);
      logEvent(id, "Removed from database");

      // Return 204 No Content to match panel expectation
      res.status(204).send();
    } catch (error) {
      console.error("Failed to delete server:", error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/:id/cargo/ship", async (req, res) => {
    try {
      const { id } = req.params;
      const cargo = req.body.cargo as CargoFile[];

      if (!Array.isArray(cargo)) {
        return res.status(400).json({ error: "Invalid cargo format" });
      }

      const server = await appState.db.get(
        "SELECT id FROM servers WHERE id = ?",
        [id],
      );

      if (!server) {
        return res.status(404).json({ error: "Server not found" });
      }

      const volumePath = path.join(
        appState.config.volumesDirectory,
        sanitizeVolumeName(id),
      );
      const logger = new InstallLogger(id, appState.wsServer);

      // Process the cargo files
      await processCargoFiles(volumePath, cargo, logger);

      res.json({ message: "Cargo shipped successfully" });
    } catch (error) {
      console.error("Failed to ship cargo:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Reinstall server
  router.post("/:id/reinstall", async (req, res) => {
    try {
      const { id } = req.params;
      const serverConfig = await fetchServerConfig(appState.config.appUrl, id);

      const server = await appState.db.get(
        "SELECT docker_id, memory_limit FROM servers WHERE id = ?",
        [id],
      );

      if (!server) {
        return res.status(404).json({ error: "Server not found" });
      }

      // Remove existing container if it exists
      if (server.docker_id) {
        try {
          const container = appState.docker.getContainer(server.docker_id);
          await container.remove({ force: true });
          logEvent(id, "Removed existing container for reinstall");
        } catch (error) {
          console.error("Failed to remove container:", error);
          logEvent(id, "Failed to remove container for reinstall", error);
        }
      }

      await appState.db.run(
        "UPDATE servers SET state = ?, docker_id = NULL WHERE id = ?",
        [ServerState.Installing, id],
      );

      // Run installation process
      logEvent(id, "Starting reinstallation process");
      await runInstallation(appState, id, serverConfig, server.memory_limit);
      logEvent(id, "Reinstallation completed");

      await appState.db.run("UPDATE servers SET state = ? WHERE id = ?", [
        ServerState.Installed,
        id,
      ]);

      res.json({ message: "Server reinstallation completed" });
    } catch (error) {
      console.error("Failed to reinstall server:", error);
      logEvent(req.params.id, "Reinstallation failed", error);
      await appState.db.run("UPDATE servers SET state = ? WHERE id = ?", [
        ServerState.InstallFailed,
        req.params.id,
      ]);
      res.status(500).json({ error: error.message });
    }
  });

  // Power actions (start, stop, restart)
  router.post("/:id/power/:action", async (req, res) => {
    try {
      const { id, action } = req.params;

      if (!["start", "stop", "restart"].includes(action)) {
        return res.status(400).json({ error: "Invalid power action" });
      }

      const server = await appState.db.get(
        "SELECT docker_id FROM servers WHERE id = ?",
        [id],
      );

      if (!server?.docker_id) {
        return res.status(404).json({ error: "Server or container not found" });
      }

      const container = appState.docker.getContainer(server.docker_id);
      logEvent(id, `Executing power action: ${action}`);

      switch (action) {
        case "start":
          await container.start();
          break;
        case "stop":
          await container.stop();
          break;
        case "restart":
          await container.restart();
          break;
      }

      // Update container status
      const status = await container.inspect();
      await appState.db.run("UPDATE servers SET state = ? WHERE id = ?", [
        status.State.Status,
        id,
      ]);

      res.json({ message: `Power action ${action} completed successfully` });
    } catch (error) {
      console.error("Failed to execute power action:", error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
