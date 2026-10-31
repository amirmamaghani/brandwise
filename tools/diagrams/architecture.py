import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
OUT = os.path.join(HERE, "..", "..", "docs", "images")
from svg import S
s=S(1240,722,"BrandWise architecture")
s.text(620,36,"BrandWise architecture",20,"700","middle","#1f2933")
# people
s.group(30,60,270,500,"People and agents","agent")
s.box(50,100,230,120,"You (the owner)",("Plan, review and approve","in the Calendar page.","You choose the audience.","Agents cannot approve."),"human")
s.box(50,250,230,150,"Agents",("bb threads (Claude Code).","\"Start agent\" in the side panel","of every page knows which","page and project you are on.","Tools only, never credentials."),"agent")
s.box(50,430,230,110,"Other MCP clients",("Any MCP client connected","to the instance can run the","same bb brandwise commands."),"world",size=12.5)
# bb instance
s.group(330,60,590,610,"Dedicated bb instance","code")
s.group(350,90,550,205,"BrandWise plugin","code")
for i,(t) in enumerate(["Calendar","Creatives","Campaigns","E-mail","Video","Settings"]):
    s.box(369+i*87,120,81,50,t,(),"code",tsize=13)
s.box(369,188,250,90,"CLI and MCP: bb brandwise",("calendar, campaign, assets,","email, editor, templates,","video, product, run-due"),"code",size=12.5)
s.box(631,188,250,90,"Skills and agent prompts",("One skill for the CLI, plus","editor and author roles;","prompts per page"),"code",size=12.5)
s.box(350,310,550,62,"Scheduler: a bb automation, every minute",("runs calendar run-due, silent when nothing is due",),"code",size=12.5)
s.group(350,388,550,150,"packages/core (no bb dependency)","store")
for i,(t,l) in enumerate([("Campaigns",("base + children",)),("Calendar",("entries, tiers,","approval")),("Assets",("files, hashes,","provenance")),("Publishing",("claim, retry,","connectors")),("E-mail",("events, metrics,","templates")),("Editor",("goals, signals,","A/B rails")) ]):
    s.box(367+i*88,420,82,102,t,l,"store",size=11,tsize=13)
s.box(350,556,260,58,"Postgres",("campaigns, calendar, events, settings",),"store",size=12)
s.box(640,556,260,58,"S3 (any S3-compatible)",("creatives, thumbnails, video",),"store",size=12)
s.text(620,646,"Local stack: Docker (Postgres + S3 emulator). Production: any managed Postgres and S3.",12,"400","middle")
# right
s.group(960,60,250,245,"Publishing connectors","code")
s.box(978,92,214,58,"Telegram",("channel, group or user",),"code",size=12)
s.box(978,160,214,80,"E-mail",("Resend today; a simulated","provider for tests; others","plug in through one adapter"),"code",size=12)
s.box(978,250,214,42,"mock",("for trying the pipeline",),"code",size=11.5,tsize=13.5)
s.box(960,332,250,92,"Outside world",("Telegram, mailboxes. Signed","webhooks come back as events","(verified, deduplicated)"),"world",size=12)
s.group(960,455,250,190,"Providers (optional)","code")
s.box(978,488,214,66,"Image and video generation",("Higgsfield, with per-call","and daily credit limits"),"code",size=12)
s.box(978,566,214,66,"Remotion video engine",("own licence; Studio is","local-only (127.0.0.1)"),"code",size=12)
# arrows
s.arrow([(280,160),(350,160)],"approves",315,150)
s.arrow([(280,325),(350,325)],"CLI / MCP",315,315)
s.arrow([(280,485),(330,485)])
s.arrow([(625,296),(625,310)])
s.arrow([(625,372),(625,388)])
s.arrow([(480,538),(480,556)]); s.arrow([(770,538),(770,556)])
s.arrow([(900,470),(935,470),(935,180),(960,180)])
s.arrow([(935,470),(935,550),(960,550)])
s.text(947,172,"publish",11,"400","middle","#52606d")
s.arrow([(1085,305),(1085,332)])
s.arrow([(1050,424),(1050,405),(1180,405)],None) if False else None
s.legend(30,704,[("human","Human"),("agent","Agent (AI)"),("code","Code"),("store","Stored data"),("world","Outside world")])
s.save(os.path.join(OUT, "architecture.svg"))
