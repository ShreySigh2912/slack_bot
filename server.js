// Server entry point for Render deployment
import expressApp from './index.js';

const PORT = parseInt(process.env.PORT, 10) || 3000;

if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}. Must be between 1 and 65535`);
  process.exit(1);
}

const server = expressApp.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('='.repeat(50));
  console.log('  SLACK ADMISSION BOT');
  console.log('='.repeat(50));
  console.log(`  Server running on port ${PORT}`);
  console.log('');
  console.log('  Endpoints:');
  console.log('    GET  /              - Healthcheck');
  console.log('    GET  /health        - Health status');
  console.log('    POST /slack/events  - Slack events');
  console.log('    GET  /slack/install - OAuth install');
  console.log('');
  console.log('  Ready to receive Slack events!');
  console.log('='.repeat(50));
  console.log('');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close((err) => {
    if (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
    console.log('Server closed');
    process.exit(0);
  });

  // Force close after 5 seconds
  setTimeout(() => {
    console.warn('Forcing shutdown after timeout');
    process.exit(1);
  }, 5000);
};

['SIGTERM', 'SIGINT', 'SIGQUIT'].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});
