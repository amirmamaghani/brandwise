import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
OUT = os.path.join(HERE, "..", "..", "docs", "images")
from svg import S
s=S(1240,560,"How a post goes from idea to published and measured")
s.text(620,38,"How a post goes from idea to published and measured",20,"700","middle","#1f2933")
w,h,gap,x0,y1=148,128,26,30,92
xs=[x0+i*(w+gap) for i in range(7)]
steps=[("1  Brief",("You or a client:","goal, audience,","product facts"),"human"),
("2  Agent drafts",("Writes the text,","makes creatives,","adds a calendar","entry. Never","publishes."),"agent"),
("3  Calendar entry",("Waits as","pending approval.","Tier 1 passes,","tier 2: one click,","tier 3: manual"),"code"),
("4  Human approval",("Review, edit,","send back with a","note, approve","or cancel"),"human"),
("5  Scheduler",("bb automation,","every minute:","calendar run-due","takes due, approved","entries"),"code"),
("6  Connector",("Telegram, e-mail,","... publishes.","2 retries, then","Failed. No connector:","Publish by hand"),"code"),
("7  Platform",("The post or","campaign goes","out to the","audience"),"world")]
for x,(t,l,k) in zip(xs,steps): s.box(x,y1,w,h,t,l,k,size=12.5,tsize=14.5)
for a,b in zip(xs,xs[1:]): s.arrow([(a+w,y1+h/2),(b,y1+h/2)])
# send back loop 4 -> 2
s.arrow([(xs[3]+w/2,y1),(xs[3]+w/2,y1-26),(xs[1]+w/2,y1-26),(xs[1]+w/2,y1-2)],"changes requested: back to the agent with a note",(xs[1]+xs[3]+w)/2,y1-34,dashed=True)
# feedback row
y2=330
s.box(xs[6],y2,w,h,"8  Events",("Signed webhooks","or polling, turned","into one event","format, deduplicated"),"code",size=12.5,tsize=14.5)
s.box(xs[4]-w/2-gap/2+20,y2,w+40,h,"9  Statistics",("Counts and metrics:","clicks, bounces, opens,","unsubscribes. Same","for every provider"),"store",size=12.5,tsize=14.5)
s.box(xs[1],y2,w+20,h,"10  Next round",("The agent reads","the numbers and","proposes the next","draft"),"agent",size=12.5,tsize=14.5)
s.arrow([(xs[6]+w/2,y1+h),(xs[6]+w/2,y2)])
s.text(xs[6]+w/2+10,y1+h+(y2-y1-h)/2+4,"the audience reacts",12,"400","start","#52606d")
s.arrow([(xs[6],y2+h/2),(xs[4]-w/2-gap/2+20+w+40,y2+h/2)])
s.arrow([(xs[4]-w/2-gap/2+20,y2+h/2),(xs[1]+w+20,y2+h/2)])
s.arrow([(xs[1]+(w+20)/2,y2),(xs[1]+(w+20)/2,y1+h+2)],"",)
# failure note, right under the connector
s.box(xs[5]-8,y1+h+18,w+16,52,"Failed / Publish by hand",("shown in the Calendar",),"warn",size=12,tsize=13)
s.arrow([(xs[5]+w/2,y1+h),(xs[5]+w/2,y1+h+18)],dashed=True,color="#D64545")
s.text(620,y2+h+38,"Agents never approve and never publish: the calendar is the only way out.",14,"700","middle","#1f2933")
s.legend(30,y2+h+72,[("human","Human"),("agent","Agent (AI)"),("code","Code"),("store","Stored data"),("world","Outside world"),("warn","Problem state")])
s.save(os.path.join(OUT, "flow.svg"))
