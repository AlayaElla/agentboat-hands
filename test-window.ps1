param([Parameter(Mandatory=$true)][string]$StatePath, [switch]$Activate)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Web.Extensions
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions -TypeDefinition @'
using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;
public class HandsTestWindow : Form {
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
    [DllImport("user32.dll")] static extern bool LogicalToPhysicalPointForPerMonitorDPI(IntPtr h, ref POINT point);
    readonly bool activate;
    readonly string statePath;
    readonly TextBox input = new TextBox();
    readonly Label label = new Label();
    int clicks=0;
    protected override bool ShowWithoutActivation { get { return !activate; } }
    public HandsTestWindow(string statePath, bool activate) {
        this.statePath=statePath; this.activate=activate;
        Text="AgentBoat hands isolated test " + System.Diagnostics.Process.GetCurrentProcess().Id;
        StartPosition=FormStartPosition.Manual; Location=new Point(80,80); ClientSize=new Size(480,180);
        AutoScaleMode=AutoScaleMode.None;
        BackColor=Color.FromArgb(230,240,250);
        label.SetBounds(20,20,440,35); label.Text="Hands desktop test - clicks: 0";
        input.SetBounds(20,75,440,36); input.Font=new Font("Microsoft YaHei UI",14); input.Multiline=true;
        Controls.Add(label); Controls.Add(input);
        input.MouseDown+=(s,e)=> { clicks++; label.Text="Hands desktop test - clicks: "+clicks; Save(); };
        input.TextChanged+=(s,e)=>Save();
        // The launcher hides the PowerShell console; explicitly show only this test form.
        Shown+=(s,e)=> { ShowWindow(Handle,activate?5:4); if(activate) { Activate(); input.Focus(); } Save(); };
        var timer=new Timer { Interval=100 };
        timer.Tick+=(s,e)=> { if(File.Exists(statePath+".stop")) Close(); };
        timer.Start(); FormClosed+=(s,e)=>timer.Dispose();
    }
    void Save() {
        var r=input.RectangleToScreen(input.ClientRectangle);
        var point=new POINT { X=r.X+r.Width/2,Y=r.Y+r.Height/2 };
        if(!LogicalToPhysicalPointForPerMonitorDPI(Handle,ref point)) throw new Exception("Test coordinate conversion failed.");
        var state=new { window_id=Handle.ToInt64().ToString(), pid=System.Diagnostics.Process.GetCurrentProcess().Id, title=Text, clicks=clicks, text=input.Text, x=point.X, y=point.Y };
        File.WriteAllText(statePath,new JavaScriptSerializer().Serialize(state),new UTF8Encoding(false));
    }
}
'@
[Windows.Forms.Application]::EnableVisualStyles()
[Windows.Forms.Application]::Run((New-Object HandsTestWindow($StatePath, [bool]$Activate)))
