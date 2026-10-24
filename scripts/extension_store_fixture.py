#!/usr/bin/env python3
"""Preview the real autofill panel with fictional data, without accounts or AI calls.

Run from the repo root, then open http://127.0.0.1:8766. Runtime assets are served
directly from extension/src; no extension files or local connection settings are changed.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = """<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Software Engineer · Northstar Labs</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f6fa;color:#202638;font:15px/1.5 system-ui,sans-serif}
header{height:72px;border-bottom:1px solid #e1e4ec;background:white;padding:22px 48px;display:flex;justify-content:space-between}
header b{font-size:19px}header span{color:#697386}main{max-width:1152px;margin:30px auto;padding:0 24px}
.intro{max-width:680px;margin-bottom:22px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6964bd;font-weight:700}
h1{font-size:30px;line-height:1.2;margin:7px 0 10px}p{color:#667085;margin:5px 0}
form{width:650px;background:white;border:1px solid #e1e4ec;border-radius:14px;padding:25px 28px}
h2{font-size:18px;margin:0 0 16px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px 20px}
label{display:block;font-size:13px;font-weight:600;color:#475467}input,textarea{display:block;width:100%;margin-top:5px;border:1px solid #cfd4df;border-radius:7px;padding:10px;font:14px system-ui;background:#fff;color:#202638}
textarea{height:80px;resize:vertical}.wide{grid-column:1/-1}fieldset{border:0;padding:0;margin:0}legend{font-size:13px;font-weight:600;color:#475467;margin-bottom:6px}
.radio{display:inline-flex;align-items:center;margin-right:20px;gap:6px}.radio input{display:inline;width:auto;margin:0}
footer{font-size:12px;color:#7b8497;margin-top:16px}button.submit{background:#343b52;color:white;padding:10px 18px;border:0;border-radius:7px;font-weight:600;margin-top:17px}
</style>
<header><b>Northstar Labs</b><span>Careers / Engineering</span></header>
<main><div class="intro"><span class="eyebrow">Engineering · Remote</span>
<h1>Software Engineer</h1><p>Build thoughtful tools with a small, collaborative team.</p></div>
<form onsubmit="event.preventDefault()"><h2>Your application</h2><div class="grid">
<label>Full name *<input name="full_name" required></label>
<label>Email address *<input type="email" name="email" required></label>
<label>Phone number<input name="phone"></label><label>Location<input name="location"></label>
<label class="wide">LinkedIn profile<input name="linkedin"></label>
<fieldset class="wide"><legend>Willing to relocate?</legend>
<label class="radio"><input type="radio" name="relocate" value="yes" required>Yes</label>
<label class="radio"><input type="radio" name="relocate" value="no" required>No</label></fieldset>
<label class="wide">Why are you interested in this role?<textarea name="interest"></textarea></label>
</div><button class="submit">Submit application</button><footer>Demonstration form · Fictional company and applicant · No application is sent</footer></form></main>
<script>
let runPanel;
const profile={full_name:'Alex Morgan',email:'alex.morgan@example.com',phone:'+1 202-555-0148',location:'Austin, TX',links:[{label:'LinkedIn',url:'https://www.linkedin.com/in/example-applicant'}],skills:['JavaScript','Python'],experience:[],education:[],answers:[],preferences:null};
const handlers={hello:()=>({mode:'idle'}),context:()=>({profile,app:{title:'Software Engineer',company_name:'Northstar Labs'},aiDrafts:false}),resume:()=>null,report:()=>null,panelPreference:()=>false,suggest:()=>({answer:null,source:'none'}),assist:(msg)=>({reply:'Thanks, I set relocation to Yes.',updates:{[msg.fields.find(f=>f.kind==='radio').key]:'Yes'},warnings:[],done:false,choices:[]})};
window.chrome={runtime:{id:'store-fixture',sendMessage:(msg,cb)=>{const response=Promise.resolve().then(()=>({ok:true,data:handlers[msg.type]?.(msg)}));return cb?void response.then(cb):response},onMessage:{addListener:fn=>{runPanel=fn}}}};
</script>
<script src="/fill.js"></script><script src="/panel-model.js"></script><script src="/panel-view.js"></script><script src="/content.js"></script>
<script>runPanel({type:'run',appId:7},{id:'store-fixture'},()=>{});</script></html>
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/", "/index.html"):
            body, mime = PAGE.encode(), "text/html; charset=utf-8"
        elif self.path in ("/fill.js", "/panel-model.js", "/panel-view.js", "/content.js"):
            body = (ROOT / "extension/src" / self.path[1:]).read_bytes()
            mime = "text/javascript; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    print("Store screenshot fixture: http://127.0.0.1:8766", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8766), Handler).serve_forever()
