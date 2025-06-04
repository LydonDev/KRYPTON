import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseUrl } from 'url';
import axios from 'axios';
import { AppState } from '../index';
import Docker, { Container } from 'dockerode';
import { Duplex } from 'stream';
import chalk from 'chalk';
import RateLimit from 'ws-rate-limit';
import crypto from 'crypto';

enum LogType {
  INFO = 'info',
  SUCCESS = 'success', 
  ERROR = 'error',
  WARNING = 'warning',
  DAEMON = 'daemon'
}

interface ConsoleSession {
  socket: WebSocket;
  container: Container;
  stream?: Duplex;
  serverId: string;
  internalId: string;
  userId: string;
  authenticated: boolean;
  logStream: any;
  stdin?: Duplex;
  lastLogIndex: number;
  lastHeartbeat: number;
}

interface ValidateResponse {
  validated: boolean;
  server: {
    id: string;
    name: string;
    internalId: string;
    node: {
      id: string;
      name: string;
      fqdn: string;
      port: number;
    }
  }
}

interface ContainerStatsResponse {
  memory_stats: {
    usage: number;
    limit: number;
  };
  cpu_stats: {
    cpu_usage: {
      total_usage: number;
    };
    system_cpu_usage: number;
    online_cpus: number;
  };
  precpu_stats: {
    cpu_usage: {
      total_usage: number;
    };
    system_cpu_usage: number;
  };
  networks?: {
    eth0?: {
      rx_bytes: number;
      tx_bytes: number;
    };
  };
}

interface CachedValidation {
  validation: ValidateResponse;
  timestamp: number;
}

export class WebSocketManager {
  private appState: AppState;
  private sessions = new Map<WebSocket, ConsoleSession>();
  private logBuffers = new Map<string, string[]>();
  private validationCache = new Map<string, CachedValidation>();
  private readonly MAX_LOGS = 100;
  private readonly INITIAL_LOGS = 10;
  private readonly CACHE_TTL = 600000; // 10 minutes in milliseconds
  private readonly MAX_PAYLOAD_SIZE = 1024 * 50; // 50KB max payload size
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly CONNECTION_TIMEOUT = 5000; // 5 seconds
  private readonly MAX_CONNECTIONS_PER_IP = 10;
  private readonly ipConnections = new Map<string, number>();

  constructor(appState: AppState) {
    this.appState = appState;
    this.configureWebSocketRouter();
    this.startCacheCleanup();
    this.startHeartbeatCheck();
  }

  private startCacheCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, cached] of this.validationCache.entries()) {
        if (now - cached.timestamp > this.CACHE_TTL) {
          this.validationCache.delete(key);
        }
      }
    }, 60000); // Clean up every minute
  }

  private startHeartbeatCheck() {
    // Removed
  }

  private validatePayloadSize(data: string): boolean {
    return Buffer.byteLength(data, 'utf8') <= this.MAX_PAYLOAD_SIZE;
  }

  private sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9-_]/g, '');
  }

  private generateCacheKey(internalId: string, token: string): string {
    return crypto.createHash('sha256').update(`${internalId}:${token}`).digest('hex');
  }

  private async validateToken(internalId: string, token: string): Promise<ValidateResponse | null> {
    const cacheKey = this.generateCacheKey(internalId, token);
    const cached = this.validationCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.validation;
    }

    try {
      console.log(token)
      const response = await axios.get(
        `${this.appState.config.appUrl}/api/servers/${internalId}/validate/${token}`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 5000 // 5 second timeout
        }
      );

      const validation = response.data;
      this.validationCache.set(cacheKey, {
        validation,
        timestamp: Date.now()
      });

      console.log('[Token Validation] Validation successful:', validation);

      return validation;
    } catch (error) {
      console.error('Token validation failed:', error);
      return null;
    }
  }

  private async handleSendCommand(session: ConsoleSession, command: string) {
    if (!command || typeof command !== 'string') {
      throw new Error('Invalid command format');
    }

    if (!this.validatePayloadSize(command)) {
      throw new Error('Command exceeds maximum allowed size');
    }

    try {
      // Improved command sanitization
      const sanitizedCommand = command
        .replace(/[^\x20-\x7E]/g, '') // Only printable ASCII
        .replace(/["'`]/g, '') // Remove quotes
        .trim();

      if (!sanitizedCommand) {
        return;
      }

      console.log('[Command Handler] Starting command execution:', sanitizedCommand);
      
      const { spawn } = require('child_process');
      
      const dockerAttach = spawn('docker', [
        'attach',
        '--sig-proxy=false',
        session.container.id
      ], {
        stdio: ['pipe', 'inherit', 'inherit'],
        timeout: 10000 // 10 second timeout
      });
  
      dockerAttach.stdin.write(sanitizedCommand + '\n');
      
      setTimeout(() => {
        try {
          dockerAttach.stdin.end();
          console.log('[Command Handler] Ended stdin');
        } catch (err) {
          console.error('[Command Handler] Error during stdin end:', err);
        }
      }, 100);

      // Set up error handling
      dockerAttach.on('error', (error: Error) => {
        console.error('[Command Handler] Process error:', error);
        session.socket.send(JSON.stringify({
          event: 'error',
          data: { message: 'Failed to execute command' }
        }));
      });
  
    } catch (error) {
      console.error('[Command Handler] Error:', error);
      throw error;
    }
  }

private async attachLogs(session: ConsoleSession) {
  try {
    if (session.logStream) {
      session.logStream.destroy();
    }

    session.logStream = await session.container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 0
    });

    let buffer = '';
    let lastLogTime = Date.now();
    let logCount = 0;

    // SINGLE event handler - remove the duplicate one from your code
    session.logStream.on('data', (chunk: Buffer) => {
      try {
        // Rate limiting for logs
        const now = Date.now();
        if (now - lastLogTime < 100) {
          logCount++;
          if (logCount > 10) {
            return;
          }
        } else {
          lastLogTime = now;
          logCount = 0;
        }

        // More robust Docker log parsing
        let offset = 0;
        
        while (offset < chunk.length) {
          // Docker multiplexed stream format:
          // [0]: stream type (0=stdin, 1=stdout, 2=stderr)
          // [1-3]: padding (should be 0)
          // [4-7]: size (big-endian uint32)
          // [8+]: actual log data
          
          if (offset + 8 > chunk.length) {
            // Not enough bytes for a complete header, treat as raw data
            const remaining = chunk.slice(offset).toString('utf8');
            buffer += remaining;
            break;
          }

          const streamType = chunk[offset];
          const padding1 = chunk[offset + 1];
          const padding2 = chunk[offset + 2]; 
          const padding3 = chunk[offset + 3];
          const size = chunk.readUInt32BE(offset + 4);

          // Validate the header structure
          const isValidHeader = (
            streamType <= 2 && 
            padding1 === 0 && 
            padding2 === 0 && 
            padding3 === 0 &&
            size > 0 && 
            size <= chunk.length - 8 &&
            offset + 8 + size <= chunk.length
          );

          if (isValidHeader) {
            // Valid Docker header - extract the message
            const messageStart = offset + 8;
            const messageEnd = messageStart + size;
            const messageBytes = chunk.slice(messageStart, messageEnd);
            const message = messageBytes.toString('utf8');
            
            buffer += message;
            offset = messageEnd;
          } else {
            // Invalid header or corrupted data - treat as plain text
            // This handles cases where Docker isn't using multiplexed streams
            const remaining = chunk.slice(offset).toString('utf8');
            buffer += remaining;
            break;
          }
        }
        
        // Process complete lines from buffer
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            // Clean the log line
            const cleaned = trimmed
              .replace('pterodactyl', 'argon')
              .trim();

            if (cleaned && this.validatePayloadSize(cleaned)) {
              this.addLogToBuffer(session.internalId, cleaned);

              session.socket.send(JSON.stringify({
                event: 'console_output',
                data: { message: cleaned }
              }));
            }
          }
        }
      } catch (error) {
        console.error('[Logs] Error processing output:', error);
      }
    });

    session.logStream.on('error', (error) => {
      console.error('[Logs] Stream error:', error);
      setTimeout(() => this.attachLogs(session), 5000);
    });

  } catch (error) {
    console.error('[Logs] Setup error:', error);
    setTimeout(() => this.attachLogs(session), 5000);
  }
}

  private async startResourceMonitoring(session: ConsoleSession) {
    let lastNetworkRx = 0;
    let lastNetworkTx = 0;
    let lastCheck = Date.now();
    
    const interval = setInterval(async () => {
      try {
        const containerInfo = await session.container.inspect();
        const state = containerInfo.State.Status;

        if (state === 'running') {
          const stats = await session.container.stats({ stream: false }) as ContainerStatsResponse;
          const now = Date.now();
          const timeDiff = (now - lastCheck) / 1000; // Convert to seconds

          // Calculate network rates
          const currentRx = stats.networks?.eth0?.rx_bytes || 0;
          const currentTx = stats.networks?.eth0?.tx_bytes || 0;
          
          const networkRates = {
            rx_rate: (currentRx - lastNetworkRx) / timeDiff, // bytes per second
            tx_rate: (currentTx - lastNetworkTx) / timeDiff  // bytes per second
          };

          lastNetworkRx = currentRx;
          lastNetworkTx = currentTx;
          lastCheck = now;

          if (session.socket.readyState === WebSocket.OPEN) {
            session.socket.send(JSON.stringify({
              event: 'stats',
              data: {
                state: state.replace('exited', 'stopped'),
                cpu_percent: this.calculateCPUPercent(stats),
                memory: {
                  used: stats.memory_stats.usage,
                  limit: stats.memory_stats.limit,
                  percent: (stats.memory_stats.usage / stats.memory_stats.limit) * 100
                },
                network: {
                  rx_bytes: currentRx,
                  tx_bytes: currentTx,
                  rx_rate: networkRates.rx_rate,
                  tx_rate: networkRates.tx_rate
                }
              }
            }));
          }
        } else {
          if (session.socket.readyState === WebSocket.OPEN) {
            session.socket.send(JSON.stringify({
              event: 'stats',
              data: { state: state.replace('exited', 'stopped') }
            }));
          }
        }
      } catch (error) {
        console.error('Failed to get container stats:', error);
        if (session.socket.readyState === WebSocket.OPEN) {
          session.socket.send(JSON.stringify({
            event: 'error',
            data: { message: 'Failed to retrieve server statistics' }
          }));
        }
      }
    }, 2000); // Update every 2 seconds

    // Clean up interval on socket close
    session.socket.on('close', () => {
      clearInterval(interval);
    });

    // Handle socket errors
    session.socket.on('error', () => {
      clearInterval(interval);
    });
  }

  private broadcastToServer(internalId: string, log: string, type: LogType = LogType.INFO) {
    try {
      if (!this.validatePayloadSize(log)) {
        console.error('[Broadcast] Log message exceeds maximum size');
        return;
      }

      // Sanitize log message
      const sanitizedLog = log
        .replace(/[^\x20-\x7E\n]/g, '') // Only allow printable ASCII
        .trim();

      if (!sanitizedLog) {
        return;
      }

      const formattedLog = this.formatLogMessage(type, sanitizedLog);
      this.addLogToBuffer(internalId, formattedLog);
      
      let broadcastCount = 0;
      const maxBroadcastsPerSecond = 10;
      const now = Date.now();
      
      for (const [socket, session] of this.sessions.entries()) {
        if (session.internalId === internalId && 
            session.authenticated && 
            socket.readyState === WebSocket.OPEN) {
          
          // Rate limit broadcasts
          if (broadcastCount >= maxBroadcastsPerSecond) {
            console.warn('[Broadcast] Rate limit reached for broadcast');
            break;
          }

          try {
            socket.send(JSON.stringify({
              event: 'console_output',
              data: { message: formattedLog }
            }));
            broadcastCount++;
          } catch (error) {
            console.error('[Broadcast] Failed to send to socket:', error);
            // Don't close the socket here, let the error handler deal with it
          }
        }
      }
    } catch (error) {
      console.error('[Broadcast] Error during broadcast:', error);
    }
  }

  private async handlePowerAction(session: ConsoleSession, action: string) {
  // Updated to include 'kill' action
  if (!['start', 'stop', 'restart', 'kill'].includes(action)) {
    throw new Error('Invalid power action');
  }

  try {
    this.broadcastToServer(session.internalId, `Performing a ${action} action on server...`, LogType.DAEMON);

    const containerInfo = await session.container.inspect();
    const currentState = containerInfo.State.Status.replace('exited', 'stopped');

    // Validate state transitions
    if (
      (action === 'start' && currentState === 'running') ||
      ((action === 'stop' || action === 'kill') && currentState === 'stopped') ||
      (action === 'restart' && currentState === 'restarting')
    ) {
      throw new Error(`Server is already in ${currentState} state`);
    }

    switch (action) {
      case 'start':
        await session.container.start();
        await this.attachLogs(session);
        break;

      case 'stop':
        await session.container.stop({
          t: 30 // Give 30 seconds for graceful shutdown
        });
        break;

      case 'kill':
        // Force kill the container immediately without graceful shutdown
        await session.container.kill();
        break;

      case 'restart':
        await session.container.restart({
          t: 30 // Give 30 seconds for graceful shutdown
        });
        await this.attachLogs(session);
        break;
    }

    // Clear log buffers on power state changes
    this.logBuffers.delete(session.internalId);

    const newContainerInfo = await session.container.inspect();
    const state = newContainerInfo.State.Status;
    const error = newContainerInfo.State.Error || '';

    // Updated status messages to handle kill action
    let statusMessage: string;
    if (state === 'running') {
      statusMessage = `${chalk.yellow('[Krypton Daemon]')} The server is now powered on and will begin the pre-boot process.`;
    } else {
      if (action === 'kill') {
        statusMessage = `${chalk.yellow('[Krypton Daemon]')} The server has been forcefully terminated.`;
      } else {
        statusMessage = `${chalk.yellow('[Krypton Daemon]')} The server has successfully been powered off.`;
      }
    }

    session.socket.send(JSON.stringify({
      event: 'power_status',
      data: {
        status: statusMessage,
        action,
        state: state.replace('exited', 'stopped'),
        error
      }
    }));

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    this.broadcastToServer(session.internalId, `Failed to ${action} server: ${errorMsg}`, LogType.ERROR);
    console.error(`Server ${action} failed:`, error);
    
    session.socket.send(JSON.stringify({
      event: 'error',
      data: { message: errorMsg }
    }));
  }
}

  private configureWebSocketRouter() {
    this.appState.wsServer.on('connection', async (socket: WebSocket, request: any) => {
      const ip = request.socket.remoteAddress;
      
      // Check connection limit per IP
      //const currentConnections = this.ipConnections.get(ip) || 0;
      //if (currentConnections >= this.MAX_CONNECTIONS_PER_IP) {
      //  socket.close(1008, 'Too many connections from this IP');
      //  return;
      //}
      //this.ipConnections.set(ip, currentConnections + 1);

      // Set connection timeout
      const connectionTimeout = setTimeout(() => {
        socket.close(1013, 'Connection took too long to authenticate');
      }, this.CONNECTION_TIMEOUT);

      console.log('[WebSocket] New connection received');
      
      const { query } = parseUrl(request.url!, true);
      const internalId = this.sanitizeId(query.server as string);
      const token = query.token as string;
  
      if (!internalId || !token) {
        console.log('[WebSocket] Missing server ID or token');
        socket.close(1008, 'Missing server ID or token');
        clearTimeout(connectionTimeout);
        return;
      }
  
      const validation = await this.validateToken(internalId, token);
      if (!validation?.validated == true) {
        console.log('[WebSocket] Token validation failed');
        socket.close(1008, 'Invalid token or access denied');
        clearTimeout(connectionTimeout);
        return;
      }
  
      const session = await this.setupContainerSession(socket, internalId, validation);
      if (!session) {
        console.log('[WebSocket] Session setup failed');
        clearTimeout(connectionTimeout);
        return;
      }

      clearTimeout(connectionTimeout);
      session.lastHeartbeat = Date.now();

      // Set up ping/pong for connection health monitoring
      socket.on('ping', () => {
        session.lastHeartbeat = Date.now();
        socket.pong();
      });

      socket.on('message', async (message: string) => {
        try {
          if (!this.validatePayloadSize(message)) {
            throw new Error('Message exceeds maximum allowed size');
          }

          const parsed = JSON.parse(message);
          session.lastHeartbeat = Date.now();
          
          switch (parsed.event) {
            case 'send_command':
              await this.handleSendCommand(session, parsed.data);
              break;

            case 'power_action':
              await this.handlePowerAction(session, parsed.data.action);
              break;

            case 'heartbeat':
              session.lastHeartbeat = Date.now();
              socket.send(JSON.stringify({ event: 'heartbeat_ack' }));
              break;
          }
        } catch (error) {
          console.error('Failed to process message:', error);
          socket.send(JSON.stringify({
            event: 'error',
            data: { message: 'Failed to process command' }
          }));
        }
      });

      socket.on('close', () => {
        try {
          if (session.stdin) {
            session.stdin.end();
          }
          if (session.stream) {
            session.stream.end();
          }
          if (session.logStream) {
            session.logStream.destroy();
          }

          // Clean up IP connection count
          const currentConnections = this.ipConnections.get(ip);
          if (currentConnections) {
            if (currentConnections <= 1) {
              this.ipConnections.delete(ip);
            } else {
              this.ipConnections.set(ip, currentConnections - 1);
            }
          }

          // Clean up session
          this.sessions.delete(socket);
          
          // Invalidate cache for this server
          const cacheKey = this.generateCacheKey(internalId, token);
          this.validationCache.delete(cacheKey);
          
        } catch (error) {
          console.error('[WebSocket] Error during cleanup:', error);
        }
      });

      socket.on('error', (error) => {
        console.error('[WebSocket] Socket error:', error);
        socket.close(1011, 'Internal server error');
      });
    });

    // Handle WSS server errors
    this.appState.wsServer.on('error', (error) => {
      console.error('[WebSocket] Server error:', error);
    });
  }

  private formatLogMessage(type: LogType, message: string): string {
    switch (type) {
      case LogType.INFO:
        return chalk.hex('90a2b9')(message);
      case LogType.SUCCESS:
        return chalk.green(message);
      case LogType.ERROR:
        return chalk.red(message);
      case LogType.WARNING:
        return chalk.yellow(message);
      case LogType.DAEMON:
        return chalk.yellow(`[Krypton Daemon]`) + ' ' + message;
      default:
        return message;
    }
  }

  private addLogToBuffer(internalId: string, log: string) {
    if (!this.logBuffers.has(internalId)) {
      this.logBuffers.set(internalId, []);
    }
    const buffer = this.logBuffers.get(internalId)!;
    
    // Prevent duplicate logs
    if (!buffer.includes(log)) {
      buffer.push(log);
      if (buffer.length > this.MAX_LOGS) {
        buffer.shift();
      }
    }
  }

  private throttle(func: Function, limit: number) {
    let inThrottle: boolean;
    return function(this: any, ...args: any[]) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    }
  }

  private async setupContainerSession(socket: WebSocket, internalId: string, validation: ValidateResponse) {
    try {
      console.log(`[WebSocket] Setting up session for server ${internalId}`);
      
      const server = await this.appState.db.get(
        'SELECT docker_id FROM servers WHERE id = ?',
        [internalId]
      );
  
      if (!server?.docker_id) {
        console.error(`[WebSocket] No docker_id found for server ${internalId}`);
        throw new Error('Server not found or no container assigned');
      }
  
      const container = this.appState.docker.getContainer(server.docker_id);
      const containerInfo = await container.inspect();
      
      const session: ConsoleSession = {
        socket,
        serverId: validation.server.id,
        internalId: validation.server.internalId,
        userId: validation.server.id,
        container,
        authenticated: true,
        logStream: null,
        lastLogIndex: 0,
        lastHeartbeat: Date.now()
      };
      
      this.sessions.set(socket, session);
  
      const logs = this.getLogsForSession(internalId);
  
      // Send historical logs
      logs.slice(-this.INITIAL_LOGS).forEach(log => {
        socket.send(JSON.stringify({
          event: 'console_output',
          data: { message: log }
        }));
      });

      // Send initial stats
      const stats = await session.container.stats({ stream: false }) as ContainerStatsResponse;
      socket.send(JSON.stringify({
        event: 'stats',
        data: {
          state: containerInfo.State.Status.replace('exited', 'stopped'),
          cpu_percent: this.calculateCPUPercent(stats),
          memory: {
            used: stats.memory_stats.usage,
            limit: stats.memory_stats.limit,
            percent: (stats.memory_stats.usage / stats.memory_stats.limit) * 100
          },
          network: stats.networks?.eth0 ?? { rx_bytes: 0, tx_bytes: 0 }
        }
      }));
  
      socket.send(JSON.stringify({
        event: 'auth_success',
        data: {
          state: containerInfo.State.Status.replace('exited', 'stopped'),
        }
      }));
  
      await this.attachLogs(session);
      await this.startResourceMonitoring(session);
  
      console.log(`[WebSocket] Session setup complete`);
      return session;
  
    } catch (error) {
      console.error('[WebSocket] Failed to set up session:', error);
      socket.close(1011, 'Failed to initialize session');
      return null;
    }
  }

  private getLogsForSession(internalId: string): string[] {
    return this.logBuffers.get(internalId) || [];
  }

  private calculateCPUPercent(stats: ContainerStatsResponse): number {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuCount = stats.cpu_stats.online_cpus;
    
    return (systemDelta > 0 && cpuDelta > 0) 
      ? Math.min((cpuDelta / systemDelta) * cpuCount * 100, 100) // Cap at 100%
      : 0;
  }
}

export function configureWebSocketRouter(appState: AppState) {
  return new WebSocketManager(appState);
}