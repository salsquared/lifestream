import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-save-plugin',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.method === 'POST' && req.url === '/api/save') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
              try {
                const data = JSON.parse(body);
                const filename = data.filename;
                const content = data.content;
                const savesDir = path.resolve(process.cwd(), '../data/map_saves');

                if (!fs.existsSync(savesDir)) {
                  fs.mkdirSync(savesDir, { recursive: true });
                }

                fs.writeFileSync(path.join(savesDir, filename), JSON.stringify(content, null, 2));

                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, message: `Saved to data/map_saves/${filename}` }));
              } catch (e) {
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, error: e.message }));
              }
            });
          } else {
            next();
          }
        });
      }
    }
  ],
})
