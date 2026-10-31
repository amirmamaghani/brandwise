import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
OUT = os.path.join(HERE, "..", "..", "docs", "images")
from svg import S
s=S(1240,600,"E-mail module: sending, events and statistics")
s.text(620,36,"E-mail module: sending, events and statistics",20,"700","middle","#1f2933")
w,gap,x0,h=188,66,18,118
cx=[x0+i*(w+gap) for i in range(5)]
yT,yB=96,300
s.text(18,yT-16,"SENDING   an approved calendar entry becomes a campaign at the provider",13,"700","start","#3B7BE8")
s.box(cx[0],yT,w,h,"Calendar entry",("Title = subject, body =","the text, link gets UTM.","Approved by a human","and due."),"human",size=12.5,tsize=14.5)
s.box(cx[1],yT,w,h,"E-mail connector",("Reads the campaign's","target: provider,","audience, sender.","Draft first, then send."),"code",size=12.5,tsize=14.5)
s.box(cx[2],yT,w,h,"EmailSender port",("Domain: create a draft,","send, status, cancel.","Knows no provider."),"code",size=12.5,tsize=14.5)
s.box(cx[3],yT,w,h,"Provider adapter",("Resend today. One file","per provider; swap it","by changing one","campaign setting."),"agent",size=12.5,tsize=14.5)
s.box(cx[4],yT,w,h,"Provider API",("Creates the campaign,","delivers to the","audience, keeps the","lists and unsubscribes."),"world",size=12.5,tsize=14.5)
for a,b in zip(cx[:4],cx[1:]): s.arrow([(a+w,yT+h/2),(b,yT+h/2)])
s.text(18,yB-16,"TRACKING   opens, clicks, bounces come back and become statistics",13,"700","start","#2E9D5B")
s.box(cx[4],yB,w,h,"Webhooks or polling",("Signed events: sent,","delivered, opened,","clicked, bounced,","complained ..."),"world",size=12.5,tsize=14.5)
s.box(cx[3],yB,w,h,"Provider adapter",("Verifies the signature,","translates to our one","event format. Keeps no","address or IP."),"agent",size=12.5,tsize=14.5)
s.box(cx[2],yB,w,h,"Ingest",("Domain: drops duplicates,","links each event to our","own send record, stores","unknown events raw."),"code",size=12.5,tsize=14.5)
s.box(cx[1],yB,w,h,"Postgres",("email_send: our record","per campaign.","email_event: append-only,","unique per provider id."),"store",size=12.5,tsize=14.5)
s.box(cx[0],yB,w,h,"Statistics",("Counts, then the metric","catalog: open, click,","bounce rates...","bb brandwise email stats"),"code",size=12.5,tsize=14.5)
s.arrow([(cx[4],yB+h/2),(cx[3]+w,yB+h/2)])
for i in (3,2,1): s.arrow([(cx[i],yB+h/2),(cx[i-1]+w,yB+h/2)])
s.arrow([(cx[3]+w/2,yT+h),(cx[3]+w/2,yB)],"",dashed=True)
s.arrow([(cx[4]+w/2,yT+h),(cx[4]+w/2,yB)])
# rules
yN=448
s.box(18,yN,590,92,"Why a provider swap does not break statistics",("Every send gets our own record; events and reports hang on it, never on","the provider's ids. Old sends keep their provider. A report over both","adds them, and a metric only shows what both providers can report."),"store",size=12.5,tsize=14)
s.box(630,yN,592,92,"Rules a provider adapter must meet (shared contract tests)",("Create drafts only, never send on its own. Reject bad signatures.","Declare which events and details it can emit; a metric it cannot","back is shown as n/a, never as 0. Return events without personal data."),"agent",size=12.5,tsize=14)
s.legend(18,574,[("human","Entry (human approved)"),("code","Domain (provider-free)"),("agent","Swappable adapter"),("store","Stored data"),("world","Provider side")])
s.save(os.path.join(OUT, "email.svg"))
