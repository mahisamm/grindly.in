"use client";

import { useCallback, useEffect, useState } from "react";
import { PageTitle, Panel, StatCard, LineChart, DonutChart, BarRows } from "../ui";

type Analytics = {
  rangeDays: number;
  visitors: {
    total: number;
    unique: number;
    todayViews: number;
    todayVisitors: number;
    series: { date: string; views: number; visitors: number }[];
    topPaths: { path: string; views: number }[];
  };
  users: {
    total: number;
    active: number;
    paused: number;
    paid: number;
    free: number;
    byPlan: { free: number; plus: number; pro: number };
    access: { pending: number; approved: number; denied: number };
    signupSeries: { date: string; count: number }[];
  };
  revenue: {
    total: number;
    plus: number;
    pro: number;
    plusCount: number;
    proCount: number;
    payingUsers: number;
    series: { date: string; amount: number }[];
    arpu: number;
  };
  funnel: { visitors: number; signups: number; approved: number; paid: number };
};

const rupee = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export default function AnalyticsPage() {
  const [d, setD] = useState<Analytics | null>(null);
  const [err, setErr] = useState("");
  const [days, setDays] = useState(30);

  const load = useCallback(() => {
    fetch(`/api/admin/analytics?days=${days}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(setD)
      .catch(() => setErr("Failed to load analytics."));
  }, [days]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (err) return <p className="font-mono text-sm text-[#ff4d4d]">{err}</p>;
  if (!d) return <p className="font-mono text-sm text-[#8b919c]">Loading…</p>;

  const labels = d.visitors.series.map((s) => s.date);

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <PageTitle title="Analytics" sub={`Traffic, growth & revenue · last ${d.rangeDays} days`} />
        <div className="flex gap-1 font-mono text-xs">
          {[7, 30, 90].map((n) => (
            <button
              key={n}
              onClick={() => setDays(n)}
              className={`rounded px-2.5 py-1 transition ${
                days === n ? "bg-[#1d2027] text-[#e6e8eb]" : "text-[#8b919c] hover:text-[#e6e8eb]"
              }`}
            >
              {n}d
            </button>
          ))}
        </div>
      </div>

      {/* Hero KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-6">
        <StatCard label="Total revenue" value={rupee(d.revenue.total)} tone="good" hint={`${d.revenue.payingUsers} paying`} />
        <StatCard label="Unique visitors" value={d.visitors.unique.toLocaleString()} hint={`${d.visitors.total.toLocaleString()} views all-time`} />
        <StatCard label="Total users" value={d.users.total} hint={`${d.users.access.pending} awaiting access`} />
        <StatCard label="Paying users" value={d.users.paid} tone={d.users.paid > 0 ? "good" : "default"} hint={`ARPU ${rupee(d.revenue.arpu)}`} />
      </div>

      {/* Revenue split */}
      <div className="grid gap-6 lg:grid-cols-3 mb-6">
        <Panel className="p-5 lg:col-span-2">
          <div className="mb-3 font-mono text-[11px] uppercase tracking-wide text-[#8b919c]">Revenue · {d.rangeDays}d</div>
          <LineChart
            labels={labels.length ? labels : d.revenue.series.map((s) => s.date)}
            series={[{ name: "revenue", color: "#36d399", values: d.revenue.series.map((s) => s.amount) }]}
            yFormat={rupee}
          />
          <div className="mt-4 grid grid-cols-3 gap-3 border-t border-[#262a33] pt-4 font-mono text-xs">
            <div>
              <div className="text-[#8b919c]">Total</div>
              <div className="mt-0.5 text-lg font-bold text-[#e6e8eb]">{rupee(d.revenue.total)}</div>
            </div>
            <div>
              <div className="text-[#8b919c]">Plus ({d.revenue.plusCount})</div>
              <div className="mt-0.5 text-lg font-bold text-[#9db4ff]">{rupee(d.revenue.plus)}</div>
            </div>
            <div>
              <div className="text-[#8b919c]">Pro ({d.revenue.proCount})</div>
              <div className="mt-0.5 text-lg font-bold text-[#c792ea]">{rupee(d.revenue.pro)}</div>
            </div>
          </div>
        </Panel>

        <Panel className="p-5">
          <div className="mb-4 font-mono text-[11px] uppercase tracking-wide text-[#8b919c]">Revenue by plan</div>
          {d.revenue.total > 0 ? (
            <DonutChart
              centerValue={rupee(d.revenue.total)}
              centerLabel="total"
              segments={[
                { label: "Plus", value: d.revenue.plus, color: "#9db4ff" },
                { label: "Pro", value: d.revenue.pro, color: "#c792ea" },
              ]}
            />
          ) : (
            <p className="font-mono text-xs text-[#5a606b]">
              No revenue yet. Paid plans activate once Razorpay keys are set — this fills in automatically.
            </p>
          )}
        </Panel>
      </div>

      {/* Traffic */}
      <div className="grid gap-6 lg:grid-cols-3 mb-6">
        <Panel className="p-5 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <div className="font-mono text-[11px] uppercase tracking-wide text-[#8b919c]">Traffic · {d.rangeDays}d</div>
            <div className="font-mono text-[11px] text-[#5a606b]">
              today: {d.visitors.todayVisitors} visitors · {d.visitors.todayViews} views
            </div>
          </div>
          <LineChart
            labels={labels}
            series={[
              { name: "views", color: "#9db4ff", values: d.visitors.series.map((s) => s.views) },
              { name: "visitors", color: "#36d399", values: d.visitors.series.map((s) => s.visitors) },
            ]}
          />
        </Panel>
        <Panel className="p-5">
          <div className="mb-4 font-mono text-[11px] uppercase tracking-wide text-[#8b919c]">Top pages</div>
          <BarRows rows={d.visitors.topPaths.map((p) => ({ label: p.path, value: p.views }))} color="#9db4ff" />
        </Panel>
      </div>

      {/* Users */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Panel className="p-5">
          <div className="mb-4 font-mono text-[11px] uppercase tracking-wide text-[#8b919c]">Plan mix</div>
          <DonutChart
            centerValue={`${d.users.total}`}
            centerLabel="users"
            segments={[
              { label: "Free", value: d.users.byPlan.free, color: "#8b919c" },
              { label: "Plus", value: d.users.byPlan.plus, color: "#9db4ff" },
              { label: "Pro", value: d.users.byPlan.pro, color: "#c792ea" },
            ]}
          />
        </Panel>

        <Panel className="p-5">
          <div className="mb-4 font-mono text-[11px] uppercase tracking-wide text-[#8b919c]">Access status</div>
          <DonutChart
            centerValue={`${d.users.access.approved}`}
            centerLabel="approved"
            segments={[
              { label: "Approved", value: d.users.access.approved, color: "#36d399" },
              { label: "Pending", value: d.users.access.pending, color: "#fbbd23" },
              { label: "Denied", value: d.users.access.denied, color: "#ff4d4d" },
            ]}
          />
        </Panel>

        <Panel className="p-5">
          <div className="mb-3 font-mono text-[11px] uppercase tracking-wide text-[#8b919c]">Signups · {d.rangeDays}d</div>
          <LineChart
            labels={d.users.signupSeries.map((s) => s.date)}
            series={[{ name: "signups", color: "#fbbd23", values: d.users.signupSeries.map((s) => s.count) }]}
          />
          <div className="mt-4 border-t border-[#262a33] pt-4 font-mono text-xs">
            <div className="mb-2 text-[#8b919c]">Funnel</div>
            {([
              ["Visitors", d.funnel.visitors],
              ["Signups", d.funnel.signups],
              ["Approved", d.funnel.approved],
              ["Paying", d.funnel.paid],
            ] as [string, number][]).map(([label, v], i, arr) => {
              const top = arr[0][1] || 1;
              return (
                <div key={label} className="mb-1.5">
                  <div className="flex justify-between">
                    <span className="text-[#8b919c]">{label}</span>
                    <span className="tabular-nums text-[#e6e8eb]">{v}</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#1d2027]">
                    <div className="h-full rounded-full bg-[#36d399]" style={{ width: `${Math.round((v / top) * 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
    </>
  );
}
