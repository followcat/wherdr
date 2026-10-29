"""Capture against a disposable, named Herdr session; always clean up owned processes."""
import json,os,pathlib,shutil,signal,socket,subprocess,time,urllib.request
root=pathlib.Path(os.environ['TUTORIAL_OUT']).resolve();root.mkdir(parents=True,exist_ok=True)
build=pathlib.Path(os.environ['TUTORIAL_BUILD']).resolve()
assert (build/'.output/server/index.mjs').is_file(), 'Build wherdr first'
port=int(os.environ.get('E2E_PORT','7696'));assert 7690<=port<=7699
with socket.socket() as probe:probe.bind(('127.0.0.1',port))
name='hwtest-video-'+str(os.getpid())
folder=pathlib.Path.home()/'.config/herdr/sessions'/name
assert not folder.exists(), 'Refusing to reuse an existing session'
runtime=root/name;runtime.mkdir()
env={k:v for k,v in os.environ.items() if not k.startswith(('HERDR','CODEX','CLAUDE'))}
config=runtime/'herdr.toml';config.write_bytes(subprocess.check_output(['herdr','--default-config'],env=env))
env['HERDR_CONFIG_PATH']=str(config)
children=[];logs=[]
try:
    def start(args,filename,child_env):
        log=(runtime/filename).open('wb');logs.append(log)
        process=subprocess.Popen(args,cwd=root,env=child_env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        children.append(process)
    start(['herdr','--session',name,'server'],'herdr.log',env)
    for _ in range(100):
        if (folder/'herdr.sock').exists():break
        time.sleep(.1)
    assert (folder/'herdr.sock').exists(), 'Isolated Herdr did not start'
    data=runtime/'data';data.mkdir()
    assert not (data/'auth.json').exists(), 'Use a fresh DATA_DIR without auth.json'
    (data/'push.json').write_text('{"subs":[]}');(data/'onboarding.json').write_text('{"done":true,"host":"Demo"}')
    app_env={**env,'HOST':'127.0.0.1','PORT':str(port),'DATA_DIR':str(data),'HOST_LABEL':'Demo','HERDR_WEB_SESSION':name,'HERDR_WEB_MACHINES':'off','WHERDR_UPDATE_CHECK':'off','WHERDR_RUNTIME_DIR':str(runtime/'run')}
    start(['node',str(build/'.output/server/index.mjs')],'app.log',app_env)
    url=f'http://127.0.0.1:{port}'
    for _ in range(100):
        try:
            with urllib.request.urlopen(url+'/api/state',timeout=1) as response:
                if json.load(response).get('session')==name:break
        except Exception:pass
        time.sleep(.2)
    capture=pathlib.Path(os.environ.get('TUTORIAL_CAPTURE',str(pathlib.Path(__file__).with_name('capture.mjs')))).resolve()
    subprocess.run(['node',str(capture)],env={**env,'TUTORIAL_URL':url},check=True)
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:child.kill();child.wait()
    for log in logs:log.close()
    shutil.rmtree(folder,ignore_errors=True)
    shutil.rmtree(runtime,ignore_errors=True)
