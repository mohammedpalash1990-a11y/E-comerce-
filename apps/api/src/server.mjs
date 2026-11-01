// Canonical API entrypoint. The previous monolithic implementation is preserved in server.legacy.mjs.
import { server } from './server.modular.mjs';
import { config } from './core.mjs';
server.listen(config.port, '0.0.0.0', () => console.log('API listening on ' + config.port));
