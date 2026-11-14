using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class HandsDesktop {
    static Mutex instance;
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; public POINT(int x, int y) { X=x; Y=y; } }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION value; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT point; public uint privateData; }
    delegate bool EnumProc(IntPtr h, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError=true)] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG message, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flag);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT p, uint flags);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr h, int type, out uint x, out uint y);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder value, uint size, out uint needed);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);

    static Dictionary<string, object> Obj(params object[] pairs) {
        var d = new Dictionary<string, object>();
        for (int i=0; i<pairs.Length; i+=2) d[(string)pairs[i]]=pairs[i+1];
        return d;
    }
    static object Bounds(Rectangle r) { return Obj("x",r.X,"y",r.Y,"width",r.Width,"height",r.Height); }
    static string ObjectName(IntPtr h) {
        var s=new StringBuilder(256); uint n;
        if (!GetUserObjectInformation(h,2,s,512,out n)) throw new Win32Exception();
        return s.ToString();
    }
    public static void Initialize(string directory) {
        if (SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero) throw new Exception("Per-monitor DPI awareness requires Windows 10 1703 or newer.");
        CheckDesktop();
        var sid=WindowsIdentity.GetCurrent().User;
        string hash;
        using(var sha=SHA256.Create()) hash=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(directory).ToUpperInvariant()))).Replace("-","");
        var security=new MutexSecurity(); security.SetAccessRuleProtection(true,false);
        security.AddAccessRule(new MutexAccessRule(sid,MutexRights.FullControl,AccessControlType.Allow));
        bool created;
        instance=new Mutex(false,"Global\\AgentBoatHands-"+sid.Value+"-"+hash,out created,security);
        try { if(!instance.WaitOne(0)) throw new Exception("Desktop agent is already running for this credential directory."); }
        catch(AbandonedMutexException) { /* The previous process died; this thread now owns the mutex. */ }
    }
    public static void CheckDesktop() {
        if (Process.GetCurrentProcess().SessionId==0 || ObjectName(GetProcessWindowStation())!="WinSta0") throw new Exception("Not in an interactive desktop session. Start the logon task with start-desktop.ps1 -RegisterLogonTask.");
        IntPtr desktop=OpenInputDesktop(0,false,0x101);
        if (desktop==IntPtr.Zero) throw new Exception("Interactive desktop is locked or unavailable. Unlock the user session.");
        try { if (ObjectName(desktop)!="Default") throw new Exception("Secure desktop is active. Desktop tools cannot access UAC or the lock screen."); }
        finally { CloseDesktop(desktop); }
    }
    static Rectangle Rect(IntPtr h) {
        RECT r; if (!GetWindowRect(h,out r)) throw new Win32Exception();
        return Rectangle.FromLTRB(r.Left,r.Top,r.Right,r.Bottom);
    }
    static IntPtr Handle(string id) {
        long n; if (!Int64.TryParse(id,out n) || n<=0 || !IsWindow(new IntPtr(n))) throw new Exception("Window no longer exists; list windows again.");
        return new IntPtr(n);
    }
    static object Window(IntPtr h) {
        var title=new StringBuilder(4096); GetWindowText(h,title,title.Capacity);
        uint pid; GetWindowThreadProcessId(h,out pid); string process="";
        try { using(var p=Process.GetProcessById((int)pid)) process=p.ProcessName; } catch (ArgumentException) {} catch (Win32Exception) {}
        return Obj("window_id",h.ToInt64().ToString(),"title",title.ToString(),"pid",pid,"process",process,"bounds",Bounds(Rect(h)),"dpi",GetDpiForWindow(h),"foreground",GetForegroundWindow()==h,"minimized",IsIconic(h));
    }
    public static object[] Windows() {
        var list=new List<object>();
        EnumWindows(delegate(IntPtr h,IntPtr _) { if(IsWindowVisible(h)) { try { list.Add(Window(h)); } catch(Win32Exception) {} } return true; },IntPtr.Zero);
        return list.ToArray();
    }
    public static object Displays() {
        var list=new List<object>(); int index=0;
        foreach(var screen in Screen.AllScreens) {
            uint x,y; var r=screen.Bounds;
            int hr=GetDpiForMonitor(MonitorFromPoint(new POINT(r.X+r.Width/2,r.Y+r.Height/2),2),0,out x,out y);
            if(hr!=0) Marshal.ThrowExceptionForHR(hr);
            list.Add(Obj("index",index++,"device",screen.DeviceName,"primary",screen.Primary,"bounds",Bounds(r),"dpiX",x,"dpiY",y));
        }
        return Obj("sessionId",Process.GetCurrentProcess().SessionId,"coordinateSpace","physical screen pixels; origin can be negative","virtualBounds",Bounds(SystemInformation.VirtualScreen),"monitors",list);
    }
    public static object Focus(string id) {
        var h=Handle(id);
        if(IsIconic(h)) { ShowWindowAsync(h,9); Thread.Sleep(100); }
        SetForegroundWindow(h);
        if(GetForegroundWindow()!=h) {
            NoHeldKeys();
            uint pid, current=GetCurrentThreadId();
            uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out pid), target=GetWindowThreadProcessId(h,out pid);
            MSG message; PeekMessage(out message,IntPtr.Zero,0,0,0);
            bool attachedForeground=false, attachedTarget=false;
            try {
                // Share the foreground input queue only while activating this window, then always detach.
                if(foreground!=0 && foreground!=current) attachedForeground=AttachThreadInput(current,foreground,true);
                if(target!=0 && target!=current && target!=foreground) attachedTarget=AttachThreadInput(current,target,true);
                BringWindowToTop(h); SetForegroundWindow(h);
            } finally {
                if(attachedTarget) AttachThreadInput(current,target,false);
                if(attachedForeground) AttachThreadInput(current,foreground,false);
            }
        }
        Thread.Sleep(80);
        if(GetForegroundWindow()!=h) throw new Exception("FOCUS_LOST: Windows refused foreground activation; no target input was sent.");
        return Window(h);
    }
    static Bitmap CaptureWindow(IntPtr h) {
        IntPtr previous=SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(h));
        if(previous==IntPtr.Zero) throw new Exception("Could not enter the target window's DPI context.");
        Bitmap bitmap=null;
        try {
            // PrintWindow paints in the target's DPI space; rescale to physical bounds on output.
            var render=Rect(h); bitmap=new Bitmap(render.Width,render.Height,PixelFormat.Format32bppArgb);
            using(var g=Graphics.FromImage(bitmap)) {
                var dc=g.GetHdc(); bool ok;
                try { ok=PrintWindow(h,dc,2); } finally { g.ReleaseHdc(dc); }
                if(!ok) throw new Exception("Window does not support PrintWindow capture. No desktop fallback was taken.");
            }
            return bitmap;
        } catch { if(bitmap!=null) bitmap.Dispose(); throw; }
        finally { SetThreadDpiAwarenessContext(previous); }
    }
    public static object Screenshot(string target,string id,int monitor,int x,int y,int width,int height,int max) {
        IntPtr h=IntPtr.Zero; Rectangle r;
        if(target=="window") { h=Handle(id); if(IsIconic(h)) throw new Exception("Window is minimized; restore it before capture."); r=Rect(h); }
        else if(target=="monitor") { var screens=Screen.AllScreens; if(monitor<0 || monitor>=screens.Length) throw new Exception("Monitor index is unavailable."); r=screens[monitor].Bounds; }
        else if(target=="region") { r=new Rectangle(x,y,width,height); if(!SystemInformation.VirtualScreen.Contains(r)) throw new Exception("Region is outside the virtual desktop."); }
        else r=SystemInformation.VirtualScreen;
        if(r.Width<=0 || r.Height<=0 || (long)r.Width*r.Height>120000000) throw new Exception("Capture bounds are empty or exceed 120 million pixels.");
        using(var source=h!=IntPtr.Zero?CaptureWindow(h):new Bitmap(r.Width,r.Height,PixelFormat.Format32bppArgb)) {
            if(h==IntPtr.Zero) using(var g=Graphics.FromImage(source)) g.CopyFromScreen(r.Location,Point.Empty,r.Size,CopyPixelOperation.SourceCopy);
            double scale=Math.Min(1.0,(double)max/Math.Max(r.Width,r.Height));
            for(int attempt=0;attempt<12;attempt++,scale*=0.75) {
                int w=Math.Max(1,(int)Math.Round(r.Width*scale)), ht=Math.Max(1,(int)Math.Round(r.Height*scale));
                using(var image=new Bitmap(w,ht)) using(var g=Graphics.FromImage(image)) using(var stream=new MemoryStream()) {
                    g.InterpolationMode=InterpolationMode.HighQualityBicubic; g.DrawImage(source,0,0,w,ht); image.Save(stream,ImageFormat.Png);
                    if(stream.Length>3500000) continue;
                    return Obj("target",target,"bounds",Bounds(r),"imageWidth",w,"imageHeight",ht,"scaleX",(double)w/r.Width,"scaleY",(double)ht/r.Height,"coordinateMapping","screenX = bounds.x + imageX / scaleX; screenY = bounds.y + imageY / scaleY","bytes",stream.Length,"data",Convert.ToBase64String(stream.ToArray()));
                }
            }
        }
        throw new Exception("Could not fit screenshot within 3.5 MB.");
    }
    static void Guard(IntPtr h) {
        CheckDesktop();
        if(!IsWindow(h) || GetForegroundWindow()!=h) throw new Exception("FOCUS_LOST: input aborted; target window is not foreground.");
    }
    static void NoHeldKeys() {
        foreach(int k in new[]{16,17,18,91,92,1,2,4}) if((GetAsyncKeyState(k)&0x8000)!=0) throw new Exception("User modifier or mouse button is held; input aborted.");
    }
    static void PointGuard(IntPtr h,int x,int y) {
        Guard(h);
        if(!Rect(h).Contains(x,y) || GetAncestor(WindowFromPoint(new POINT(x,y)),2)!=h) throw new Exception("POINT_BLOCKED: point is outside the target or covered by another window; input aborted.");
    }
    static void Send(params INPUT[] events) {
        if(SendInput((uint)events.Length,events,Marshal.SizeOf(typeof(INPUT)))!=events.Length) throw new Exception("SendInput failed or partially completed (possibly an elevated target). Outcome is unknown; do not retry automatically.");
    }
    static INPUT M(uint flags,int data) { return new INPUT{type=0,value=new UNION{mouse=new MOUSEINPUT{flags=flags,data=unchecked((uint)data)}}}; }
    static INPUT K(ushort vk,ushort scan,uint flags) { return new INPUT{type=1,value=new UNION{key=new KEYBDINPUT{vk=vk,scan=scan,flags=flags}}}; }
    static INPUT MoveEvent(int x,int y) {
        var r=SystemInformation.VirtualScreen;
        return new INPUT{type=0,value=new UNION{mouse=new MOUSEINPUT{dx=(int)Math.Round((x-r.X)*65535.0/Math.Max(1,r.Width-1)),dy=(int)Math.Round((y-r.Y)*65535.0/Math.Max(1,r.Height-1)),flags=0xC001}}};
    }
    static void Move(IntPtr h,int x,int y) {
        PointGuard(h,x,y); Send(MoveEvent(x,y));
    }
    public static object Mouse(string id,string action,int x,int y,string button,int toX,int toY,int duration,int delta,string axis) {
        var h=Handle(id); Guard(h); NoHeldKeys();
        uint down=button=="right"?8u:button=="middle"?32u:2u, up=down*2;
        Move(h,x,y);
        if(action=="click" || action=="double_click") {
            int count=action=="double_click"?2:1;
            for(int i=0;i<count;i++) {
                PointGuard(h,x,y);
                // Position and button events share one batch so hardware motion cannot redirect a click.
                try { Send(MoveEvent(x,y),M(down,0),M(up,0)); } catch { Send(M(up,0)); throw; }
                if(i+1<count) Thread.Sleep(60);
            }
        } else if(action=="drag") {
            PointGuard(h,toX,toY); PointGuard(h,x,y); bool pressed=false;
            try {
                pressed=true; Send(MoveEvent(x,y),M(down,0));
                int steps=Math.Max(2,duration/20);
                for(int i=1;i<=steps;i++) { Thread.Sleep(duration/steps); Move(h,x+(int)Math.Round((toX-x)*(double)i/steps),y+(int)Math.Round((toY-y)*(double)i/steps)); }
                PointGuard(h,toX,toY);
            } finally { if(pressed) Send(M(up,0)); }
        } else if(action=="scroll") { PointGuard(h,x,y); Send(MoveEvent(x,y),M(axis=="horizontal"?0x1000u:0x800u,delta)); }
        return Obj("ok",true,"window_id",id,"action",action);
    }
    public static object TypeText(string id,string text) {
        var h=Handle(id); Guard(h); NoHeldKeys(); int count=0;
        foreach(char c in text.Replace("\r\n","\n").Replace('\r','\n')) {
            Guard(h); NoHeldKeys();
            if(c=='\n' || c=='\t') { ushort vk=c=='\n'?(ushort)13:(ushort)9; Send(K(vk,0,0),K(vk,0,2)); }
            else Send(K(0,c,4),K(0,c,6));
            count++;
        }
        return Obj("ok",true,"window_id",id,"charactersSent",count);
    }
    static ushort VirtualKey(string key) {
        key=key.ToUpperInvariant();
        if(key.Length==1) return (ushort)key[0];
        if(key[0]=='F' && key.Length<=3) return (ushort)(111+Int32.Parse(key.Substring(1)));
        var names=new Dictionary<string,ushort>{{"CTRL",17},{"ALT",18},{"SHIFT",16},{"WIN",91},{"ENTER",13},{"TAB",9},{"ESC",27},{"SPACE",32},{"BACKSPACE",8},{"DELETE",46},{"INSERT",45},{"HOME",36},{"END",35},{"PAGEUP",33},{"PAGEDOWN",34},{"LEFT",37},{"RIGHT",39},{"UP",38},{"DOWN",40},{"PRINTSCREEN",44}};
        return names[key];
    }
    public static object Key(string id,string[] keys) {
        var h=Handle(id); Guard(h); NoHeldKeys(); var events=new List<INPUT>(); var releases=new List<INPUT>();
        foreach(string key in keys) { ushort vk=VirtualKey(key); uint extended=(vk>=33 && vk<=46 || vk==91)?1u:0u; events.Add(K(vk,0,extended)); releases.Insert(0,K(vk,0,extended|2)); }
        events.AddRange(releases); Guard(h);
        try { Send(events.ToArray()); } catch { Send(releases.ToArray()); throw; }
        return Obj("ok",true,"window_id",id,"keys",keys);
    }
}
