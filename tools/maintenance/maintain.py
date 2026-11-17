"""Local skill maintenance. Fetch/merge never deploy; publish requires an exact reviewed commit."""
from pathlib import Path, PurePosixPath
import argparse, datetime, hashlib, json, os, shutil, subprocess, sys

ROOT = Path(os.environ.get('MYSKILLHUB_MAINTENANCE_HOME', Path.home() / '.myskillhub' / 'maintenance')).expanduser().resolve()
CONFIG = ROOT / 'config.json'

def run(args, cwd=None, binary=False, check=True):
    p = subprocess.run(args, cwd=cwd, capture_output=True)
    if check and p.returncode:
        raise RuntimeError((p.stderr or p.stdout).decode('utf-8', errors='replace'))
    if not check:return p
    return p.stdout if binary else p.stdout.decode('utf-8').strip()

def git(s, *args, **kw):return run(['git', '-C', s['repo'], *args], **kw)

def hashes(path):
    root=Path(path)
    if not root.is_dir():raise RuntimeError(f'Missing directory: {root}')
    result={}
    for f in sorted(root.rglob('*')):
        if f.is_symlink() or (hasattr(f,'is_junction') and f.is_junction()):raise RuntimeError(f'Links not allowed: {f}')
        if f.is_file():result[f.relative_to(root).as_posix()]=hashlib.sha256(f.read_bytes()).hexdigest()
    return result

def clean(s):
    if git(s,'branch','--show-current') != s['branch']:raise RuntimeError('Switch to '+s['branch']+' first')
    if git(s,'status','--porcelain'):raise RuntimeError('Commit or resolve all working-tree changes first')
    if git(s,'rev-parse','-q','--verify','MERGE_HEAD',check=False).returncode==0:raise RuntimeError('Finish or abort the existing merge first')

def committed_files(s, revision):
    prefix='' if s['skill_path']=='.' else s['skill_path'].rstrip('/')+'/'
    output=git(s,'ls-tree','-r','-z',revision,'--',s['skill_path'],binary=True)
    result={}
    for item in output.split(b'\0'):
        if not item:continue
        meta,path=item.split(b'\t',1);mode,kind,oid=meta.decode().split();path=path.decode('utf-8')
        if kind!='blob' or mode not in ('100644','100755'):raise RuntimeError('Submodules and links require manual review')
        relative=path[len(prefix):]
        parts=PurePosixPath(relative)
        if not relative or parts.is_absolute() or '..' in parts.parts or any(':' in p for p in parts.parts):raise RuntimeError('Unsafe export path')
        result[relative]=git(s,'cat-file','blob',oid,binary=True)
    if 'SKILL.md' not in result:raise RuntimeError('The committed skill has no SKILL.md')
    return result

def content_hashes(content):return {k:hashlib.sha256(v).hexdigest() for k,v in content.items()}

def check_upstream(s):
    clean(s)
    if not s['upstream_remote']:return {'skill':s['name'],'status':'local_only','message':'No verified upstream; nothing fetched or merged'}
    git(s,'fetch','--no-tags',s['upstream_remote'])
    ref=s['upstream_remote']+'/'+s['upstream_branch']
    return {'skill':s['name'],'upstream':ref,'ahead_behind':git(s,'rev-list','--left-right','--count','HEAD...'+ref),'incoming':git(s,'log','--oneline','HEAD..'+ref),'skill_diff':git(s,'diff','--stat','HEAD...'+ref,'--',s['skill_path'])}

def merge_upstream(s):
    check_upstream(s)
    if not s['upstream_remote']:raise RuntimeError('No verified upstream; refusing to guess')
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    git(s,'tag','before-merge-'+stamp)
    p=git(s,'merge','--no-edit',s['upstream_remote']+'/'+s['upstream_branch'],check=False)
    if p.returncode:
        conflicts=git(s,'diff','--name-only','--diff-filter=U')
        raise RuntimeError('Merge stopped; nothing published. Resolve and commit, or git merge --abort.\n'+conflicts+'\n'+p.stderr.decode(errors='replace'))
    return {'skill':s['name'],'merged_commit':git(s,'rev-parse','HEAD'),'published':False,'message':'Review changes and validate this commit before publishing'}

def publish(config,s,reviewed,apply):
    clean(s);head=git(s,'rev-parse','HEAD')
    if reviewed!=head:raise RuntimeError('--reviewed-commit must equal the current full HEAD SHA')
    payload=committed_files(s,head);expected=content_hashes(payload)
    cli=config['cli']
    skills=json.loads(run([cli,'--json','skills','list']))
    current=next(x for x in skills if x['id']==s['skill_id'])
    if set(current['deployed_to'])!=set(s['agents']):raise RuntimeError('Agent assignment changed; update config after reviewing it')
    agents={a['key']:a for a in json.loads(run([cli,'--json','agents','list']))}
    paths=[Path(s['released_path']),Path(current['path'])]+[Path(agents[a]['skills_dir'])/s['name'] for a in s['agents']]
    for p in paths:
        if hashes(p)!=s['released_hashes']:raise RuntimeError(f'Unpublished local changes at {p}; import into the maintenance branch first')
    report={'skill':s['name'],'reviewed_commit':head,'changed_files':sorted(k for k in expected.keys()|s['released_hashes'].keys() if expected.get(k)!=s['released_hashes'].get(k)),'agents':s['agents'],'applied':False}
    if not apply:return report
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    journal=ROOT/'history'/s['name']/stamp;journal.mkdir(parents=True)
    shutil.copy2(CONFIG,journal/'config-before.json')
    for i,p in enumerate(paths):shutil.copytree(p,journal/str(i))
    (journal/'paths.json').write_text(json.dumps([str(p) for p in paths],indent=2),encoding='utf-8')
    release=Path(s['released_path']).resolve()
    if not release.is_relative_to((ROOT/'released').resolve()):raise RuntimeError('Release path escaped maintenance root')
    try:
        # Only remove obsolete files inside the explicitly verified release directory.
        for f in release.rglob('*'):
            if f.is_file() and f.relative_to(release).as_posix() not in payload:f.unlink()
        for name,data in payload.items():
            target=release/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
        result=json.loads(run([cli,'--json','skills','install',str(release),'--local','--name',s['name']]))
        if result['skill_id']!=s['skill_id']:raise RuntimeError('Unexpected manager identity change')
        for agent in s['agents']:
            run([cli,'--json','skills','deploy',s['name'],'--agent',agent,'--dry-run'])
            run([cli,'--json','skills','deploy',s['name'],'--agent',agent])
        for p in paths:
            if hashes(p)!=expected:raise RuntimeError(f'Publish verification failed: {p}')
        s['released_commit']=head;s['released_hashes']=expected
        temp=CONFIG.with_suffix('.json.tmp');temp.write_text(json.dumps(config,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(CONFIG)
        report['applied']=True
    except Exception as e:
        (journal/'FAILED.txt').write_text(str(e),encoding='utf-8')
        raise RuntimeError(f'Publish incomplete; stop further updates. Recovery copies and prior config: {journal}. {e}')
    (journal/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return report

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['status','check','merge','publish'])
    parser.add_argument('skill',help='skill name; all is supported for status/check')
    parser.add_argument('--reviewed-commit');parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    if not CONFIG.is_file():raise RuntimeError(f'Maintenance configuration not found: {CONFIG}. See tools/maintenance/README.md.')
    config=json.loads(CONFIG.read_text(encoding='utf-8'))
    selected=[s for s in config['skills'] if s['name']==args.skill or args.skill=='all']
    if not selected:raise RuntimeError('Unknown skill')
    if args.action in ('merge','publish') and len(selected)!=1:raise RuntimeError('Merge/publish one skill at a time')
    for s in selected:
        if args.action=='status':result={'skill':s['name'],'repo':s['repo'],'upstream_branch':s['upstream_branch'],'baseline':s['baseline_kind'],'head':git(s,'rev-parse','HEAD'),'released':s['released_commit'],'worktree':git(s,'status','--short')}
        elif args.action=='check':result=check_upstream(s)
        elif args.action=='merge':result=merge_upstream(s)
        else:result=publish(config,s,args.reviewed_commit,args.apply)
        print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
