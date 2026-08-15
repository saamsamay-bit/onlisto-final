from http.server import HTTPServer, BaseHTTPRequestHandler
import json, os

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len)
        data = json.loads(body)
        filepath = data.get('path', '')
        content = data.get('content', '')
        
        # Security: only allow onlisto-va folder
        if 'onlisto-va' not in filepath:
            self.send_response(403)
            self.end_headers()
            return
            
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"success": True, "path": filepath}).encode())
    
    def log_message(self, format, *args):
        pass  # quiet

server = HTTPServer(('localhost', 9876), Handler)
print("File server running on http://localhost:9876")
print("Ready for file writes.")
server.serve_forever()