import os from 'os';

/**
 * System Health Monitor
 * Tracks CPU, memory, and performance metrics
 */

class HealthMonitor {
  constructor() {
    this.metrics = {
      cpu: {
        usage: 0,
        loadAverage: [],
        cores: os.cpus().length,
      },
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: 0,
        usage: 0,
      },
      system: {
        uptime: os.uptime(),
        platform: os.platform(),
        arch: os.arch(),
      },
      api: {
        requestCount: 0,
        errorCount: 0,
        avgResponseTime: 0,
        responseTimes: [],
      },
      socket: {
        connections: 0,
        messages: 0,
      },
      database: {
        connectionPool: 0,
        queryCount: 0,
        avgQueryTime: 0,
        queryTimes: [],
      },
      lastUpdate: new Date(),
    };
    
    this.startMonitoring();
  }

  startMonitoring() {
    // Update metrics every 5 seconds
    setInterval(() => {
      this.updateMetrics();
    }, 5000);
  }

  updateMetrics() {
    // Update CPU metrics
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    
    this.metrics.cpu.loadAverage = loadAvg;
    this.metrics.cpu.usage = this.calculateCPUUsage();
    
    // Update memory metrics
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    this.metrics.memory.total = totalMem;
    this.metrics.memory.free = freeMem;
    this.metrics.memory.used = usedMem;
    this.metrics.memory.usage = (usedMem / totalMem) * 100;
    
    // Update system metrics
    this.metrics.system.uptime = os.uptime();
    
    // Calculate API response time average
    if (this.metrics.api.responseTimes.length > 0) {
      const sum = this.metrics.api.responseTimes.reduce((a, b) => a + b, 0);
      this.metrics.api.avgResponseTime = sum / this.metrics.api.responseTimes.length;
      // Keep only last 100 response times
      if (this.metrics.api.responseTimes.length > 100) {
        this.metrics.api.responseTimes = this.metrics.api.responseTimes.slice(-100);
      }
    }
    
    // Calculate DB query time average
    if (this.metrics.database.queryTimes.length > 0) {
      const sum = this.metrics.database.queryTimes.reduce((a, b) => a + b, 0);
      this.metrics.database.avgQueryTime = sum / this.metrics.database.queryTimes.length;
      // Keep only last 100 query times
      if (this.metrics.database.queryTimes.length > 100) {
        this.metrics.database.queryTimes = this.metrics.database.queryTimes.slice(-100);
      }
    }
    
    this.metrics.lastUpdate = new Date();
  }

  calculateCPUUsage() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - (100 * idle / total);
    
    return usage;
  }

  recordAPIRequest(responseTime, isError = false) {
    this.metrics.api.requestCount++;
    if (isError) {
      this.metrics.api.errorCount++;
    }
    this.metrics.api.responseTimes.push(responseTime);
  }

  recordSocketConnection() {
    this.metrics.socket.connections++;
  }

  recordSocketDisconnection() {
    this.metrics.socket.connections = Math.max(0, this.metrics.socket.connections - 1);
  }

  recordSocketMessage() {
    this.metrics.socket.messages++;
  }

  recordDatabaseQuery(queryTime) {
    this.metrics.database.queryCount++;
    this.metrics.database.queryTimes.push(queryTime);
  }

  getMetrics() {
    return {
      ...this.metrics,
      memory: {
        ...this.metrics.memory,
        totalMB: Math.round(this.metrics.memory.total / 1024 / 1024),
        freeMB: Math.round(this.metrics.memory.free / 1024 / 1024),
        usedMB: Math.round(this.metrics.memory.used / 1024 / 1024),
      },
      api: {
        ...this.metrics.api,
        errorRate: this.metrics.api.requestCount > 0 
          ? (this.metrics.api.errorCount / this.metrics.api.requestCount) * 100 
          : 0,
      },
    };
  }

  getHealthStatus() {
    const metrics = this.getMetrics();
    
    // Determine overall health status
    let status = 'healthy';
    const issues = [];
    
    if (metrics.memory.usage > 90) {
      status = 'critical';
      issues.push('High memory usage');
    } else if (metrics.memory.usage > 75) {
      status = status === 'healthy' ? 'warning' : status;
      issues.push('Elevated memory usage');
    }
    
    if (metrics.cpu.usage > 90) {
      status = 'critical';
      issues.push('High CPU usage');
    } else if (metrics.cpu.usage > 75) {
      status = status === 'healthy' ? 'warning' : status;
      issues.push('Elevated CPU usage');
    }
    
    if (metrics.api.errorRate > 5) {
      status = 'critical';
      issues.push('High error rate');
    } else if (metrics.api.errorRate > 1) {
      status = status === 'healthy' ? 'warning' : status;
      issues.push('Elevated error rate');
    }
    
    if (metrics.api.avgResponseTime > 1000) {
      status = 'critical';
      issues.push('Slow API response times');
    } else if (metrics.api.avgResponseTime > 500) {
      status = status === 'healthy' ? 'warning' : status;
      issues.push('Elevated API response times');
    }
    
    return {
      status,
      issues,
      metrics,
    };
  }
}

// Singleton instance
let healthMonitorInstance = null;

export function getHealthMonitor() {
  if (!healthMonitorInstance) {
    healthMonitorInstance = new HealthMonitor();
  }
  return healthMonitorInstance;
}

export default HealthMonitor;
