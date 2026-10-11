var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
/*!
 * @license
 * TradingView Lightweight Charts™ v5.2.1
 * Copyright (c) 2026 TradingView, Inc.
 * Licensed under Apache License 2.0 https://www.apache.org/licenses/LICENSE-2.0
 */
!function () {
    "use strict";
    var _j;
    var t = { title: "", visible: !0, hitTestTolerance: 3, lastValueVisible: !0, priceLineVisible: !0, priceLineSource: 0, priceLineWidth: 1, priceLineColor: "", priceLineStyle: 2, baseLineVisible: !0, baseLineWidth: 1, baseLineColor: "#B2B5BE", baseLineStyle: 0, priceFormat: { type: "price", precision: 2, minMove: .01 } };
    var i, n;
    function s(t, i) { var n = function (t, i) { switch (t) {
        case 0:
        default: return [];
        case 1: return [i, i];
        case 2: return [2 * i, 2 * i];
        case 3: return [6 * i, 6 * i];
        case 4: return [i, 4 * i];
    } }(i, t.lineWidth); return t.setLineDash(n), n; }
    function e(t, i, n, s) { t.beginPath(); var e = t.lineWidth % 2 ? .5 : 0; t.moveTo(n, i + e), t.lineTo(s, i + e), t.stroke(); }
    function r(t, i) { if (!t)
        throw new Error("Assertion failed" + (i ? ": " + i : "")); }
    function h(t) { if (void 0 === t)
        throw new Error("Value is undefined"); return t; }
    function a(t) { if (null === t)
        throw new Error("Value is null"); return t; }
    function l(t) { return a(h(t)); }
    !function (t) { t[t.Simple = 0] = "Simple", t[t.WithSteps = 1] = "WithSteps", t[t.Curved = 2] = "Curved"; }(i || (i = {})), function (t) { t[t.Solid = 0] = "Solid", t[t.Dotted = 1] = "Dotted", t[t.Dashed = 2] = "Dashed", t[t.LargeDashed = 3] = "LargeDashed", t[t.SparseDotted = 4] = "SparseDotted"; }(n || (n = {}));
    var o = /** @class */ (function () {
        function o() {
            this.t = [];
        }
        o.prototype.i = function (t, i, n) { var s = { h: t, l: i, o: !0 === n }; this.t.push(s); };
        o.prototype._ = function (t) { var i = this.t.findIndex((function (i) { return t === i.h; })); i > -1 && this.t.splice(i, 1); };
        o.prototype.u = function (t) { this.t = this.t.filter((function (i) { return i.l !== t; })); };
        o.prototype.p = function (t, i, n) { var s = __spreadArray([], this.t, true); this.t = this.t.filter((function (t) { return !t.o; })), s.forEach((function (s) { return s.h(t, i, n); })); };
        o.prototype.v = function () { return this.t.length > 0; };
        o.prototype.m = function () { this.t = []; };
        return o;
    }());
    function _(t) {
        var i = [];
        for (var _j = 1; _j < arguments.length; _j++) {
            i[_j - 1] = arguments[_j];
        }
        for (var _k = 0, i_1 = i; _k < i_1.length; _k++) {
            var n_1 = i_1[_k];
            for (var i_2 in n_1)
                void 0 !== n_1[i_2] && Object.prototype.hasOwnProperty.call(n_1, i_2) && !["__proto__", "constructor", "prototype"].includes(i_2) && ("object" != typeof n_1[i_2] || void 0 === t[i_2] || Array.isArray(n_1[i_2]) ? t[i_2] = n_1[i_2] : _(t[i_2], n_1[i_2]));
        }
        return t;
    }
    function u(t) { return "number" == typeof t && isFinite(t); }
    function c(t) { return "number" == typeof t && t % 1 == 0; }
    function d(t) { return "string" == typeof t; }
    function f(t) { return "boolean" == typeof t; }
    function p(t) { var i = t; if (!i || "object" != typeof i)
        return i; var n, s, e; for (s in n = Array.isArray(i) ? [] : {}, i)
        i.hasOwnProperty(s) && (e = i[s], n[s] = e && "object" == typeof e ? p(e) : e); return n; }
    function v(t) { return null !== t; }
    function m(t) { return null === t ? void 0 : t; }
    var w = "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";
    function g(t, i, n) { return void 0 === i && (i = w), "".concat(n = void 0 !== n ? "".concat(n, " ") : "").concat(t, "px ").concat(i); }
    var M = /** @class */ (function () {
        function M(t) {
            this.M = { S: 1, C: 5, P: NaN, k: "", T: "", R: "", D: "", I: 0, V: 0, B: 0, A: 0, L: 0 }, this.O = t;
        }
        M.prototype.N = function () { var t = this.M, i = this.F(), n = this.W(); return t.P === i && t.T === n || (t.P = i, t.T = n, t.k = g(i, n), t.A = 2.5 / 12 * i, t.I = t.A, t.V = i / 12 * t.C, t.B = i / 12 * t.C, t.L = 0), t.R = this.H(), t.D = this.U(), this.M; };
        M.prototype.H = function () { return this.O.N().layout.textColor; };
        M.prototype.U = function () { return this.O.$(); };
        M.prototype.F = function () { return this.O.N().layout.fontSize; };
        M.prototype.W = function () { return this.O.N().layout.fontFamily; };
        return M;
    }());
    function b(t) { return t < 0 ? 0 : t > 255 ? 255 : Math.round(t) || 0; }
    function S(t) { return .199 * t[0] + .687 * t[1] + .114 * t[2]; }
    var x = /** @class */ (function () {
        function x(t, i) {
            this.j = new Map, this.q = t, i && (this.j = i);
        }
        x.prototype.Y = function (t, i) { if ("transparent" === t)
            return t; var n = this.K(t), s = n[3]; return "rgba(".concat(n[0], ", ").concat(n[1], ", ").concat(n[2], ", ").concat(i * s, ")"); };
        x.prototype.G = function (t) { var i = this.K(t); return { Z: "rgb(".concat(i[0], ", ").concat(i[1], ", ").concat(i[2], ")"), X: S(i) > 160 ? "black" : "white" }; };
        x.prototype.J = function (t) { return S(this.K(t)); };
        x.prototype.tt = function (t, i, n) { var _j = this.K(t), s = _j[0], e = _j[1], r = _j[2], h = _j[3], _k = this.K(i), a = _k[0], l = _k[1], o = _k[2], _ = _k[3], u = [b(s + n * (a - s)), b(e + n * (l - e)), b(r + n * (o - r)), (c = h + n * (_ - h), c <= 0 || c > 1 ? Math.min(Math.max(c, 0), 1) : Math.round(1e4 * c) / 1e4)]; var c; return "rgba(".concat(u[0], ", ").concat(u[1], ", ").concat(u[2], ", ").concat(u[3], ")"); };
        x.prototype.K = function (t) { var i = this.j.get(t); if (i)
            return i; var n = function (t) { var i = document.createElement("div"); i.style.display = "none", document.body.appendChild(i), i.style.color = t; var n = window.getComputedStyle(i).color; return document.body.removeChild(i), n; }(t), s = n.match(/^rgba?\s*\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d*\.?\d+))?\)$/); if (!s) {
            if (this.q.length)
                for (var _j = 0, _k = this.q; _j < _k.length; _j++) {
                    var i_3 = _k[_j];
                    var n_2 = i_3(t);
                    if (n_2)
                        return this.j.set(t, n_2), n_2;
                }
            throw new Error("Failed to parse color: ".concat(t));
        } var e = [parseInt(s[1], 10), parseInt(s[2], 10), parseInt(s[3], 10), s[4] ? parseFloat(s[4]) : 1]; return this.j.set(t, e), e; };
        return x;
    }());
    var C = /** @class */ (function () {
        function C() {
            this.it = [];
        }
        C.prototype.nt = function (t) { this.it = t; };
        C.prototype.st = function (t, i, n) { this.it.forEach((function (s) { s.st(t, i, n); })); };
        return C;
    }());
    var y = /** @class */ (function () {
        function y() {
        }
        y.prototype.st = function (t, i, n) {
            var _this = this;
            t.useBitmapCoordinateSpace((function (t) { return _this.et(t, i, n); }));
        };
        return y;
    }());
    var P = /** @class */ (function (_super) {
        __extends(P, _super);
        function P() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.rt = null;
            return _this;
        }
        P.prototype.ht = function (t) { this.rt = t; };
        P.prototype.et = function (_j) {
            var t = _j.context, i = _j.horizontalPixelRatio, n = _j.verticalPixelRatio;
            if (null === this.rt || null === this.rt.lt)
                return;
            var s = this.rt.lt, e = this.rt, r = Math.max(1, Math.floor(i)) % 2 / 2, h = function (h) { t.beginPath(); for (var a_1 = s.to - 1; a_1 >= s.from; --a_1) {
                var s_1 = e.ot[a_1], l_1 = Math.round(s_1._t * i) + r, o_1 = s_1.ut * n, _1 = h * n + r;
                t.moveTo(l_1, o_1), t.arc(l_1, o_1, _1, 0, 2 * Math.PI);
            } t.fill(); };
            e.ct > 0 && (t.fillStyle = e.dt, h(e.ft + e.ct)), t.fillStyle = e.vt, h(e.ft);
        };
        return P;
    }(y));
    function k() { return { ot: [{ _t: 0, ut: 0, wt: 0, gt: 0 }], vt: "", dt: "", ft: 0, ct: 0, lt: null }; }
    var T = { from: 0, to: 1 };
    var R = /** @class */ (function () {
        function R(t, i, n) {
            this.Mt = new C, this.bt = [], this.St = [], this.xt = !0, this.O = t, this.Ct = i, this.yt = n, this.Mt.nt(this.bt);
        }
        R.prototype.Pt = function (t) { this.kt(), this.xt = !0; };
        R.prototype.Tt = function () { return this.xt && (this.Rt(), this.xt = !1), this.Mt; };
        R.prototype.kt = function () { var t = this.yt.Dt(); t.length !== this.bt.length && (this.St = t.map(k), this.bt = this.St.map((function (t) { var i = new P; return i.ht(t), i; })), this.Mt.nt(this.bt)); };
        R.prototype.Rt = function () {
            var _this = this;
            var t = 2 === this.Ct.N().mode || !this.Ct.It(), i = this.yt.Vt(), n = this.Ct.Et(), s = this.O.Bt();
            this.kt(), i.forEach((function (i, e) { var _j; var r = _this.St[e], h = i.At(n), a = i.zt(); !t && null !== h && i.It() && null !== a ? (r.vt = h.Lt, r.ft = h.ft, r.ct = h.Ot, r.ot[0].gt = h.gt, r.ot[0].ut = i.Ft().Nt(h.gt, a.Wt), r.dt = (_j = h.Ht) !== null && _j !== void 0 ? _j : _this.O.Ut(r.ot[0].ut / i.Ft().$t()), r.ot[0].wt = n, r.ot[0]._t = s.jt(n), r.lt = T) : r.lt = null; }));
        };
        return R;
    }());
    var D = /** @class */ (function (_super) {
        __extends(D, _super);
        function D(t) {
            var _this = this;
            _this = _super.call(this) || this, _this.qt = t;
            return _this;
        }
        D.prototype.et = function (_j) {
            var t = _j.context, i = _j.bitmapSize, n = _j.horizontalPixelRatio, r = _j.verticalPixelRatio;
            if (null === this.qt)
                return;
            var h = this.qt.Yt.It, a = this.qt.Kt.It;
            if (!h && !a)
                return;
            var l = Math.round(this.qt._t * n), o = Math.round(this.qt.ut * r);
            t.lineCap = "butt", h && l >= 0 && (t.lineWidth = Math.floor(this.qt.Yt.ct * n), t.strokeStyle = this.qt.Yt.R, t.fillStyle = this.qt.Yt.R, s(t, this.qt.Yt.Gt), function (t, i, n, s) { t.beginPath(); var e = t.lineWidth % 2 ? .5 : 0; t.moveTo(i + e, n), t.lineTo(i + e, s), t.stroke(); }(t, l, 0, i.height)), a && o >= 0 && (t.lineWidth = Math.floor(this.qt.Kt.ct * r), t.strokeStyle = this.qt.Kt.R, t.fillStyle = this.qt.Kt.R, s(t, this.qt.Kt.Gt), e(t, o, 0, i.width));
        };
        return D;
    }(y));
    var I = /** @class */ (function () {
        function I(t, i) {
            this.xt = !0, this.Zt = { Yt: { ct: 1, Gt: 0, R: "", It: !1 }, Kt: { ct: 1, Gt: 0, R: "", It: !1 }, _t: 0, ut: 0 }, this.Xt = new D(this.Zt), this.Jt = t, this.yt = i;
        }
        I.prototype.Pt = function () { this.xt = !0; };
        I.prototype.Tt = function (t) { return this.xt && (this.Rt(), this.xt = !1), this.Xt; };
        I.prototype.Rt = function () { var t = this.Jt.It(), i = this.yt.Qt().N().crosshair, n = this.Zt; if (2 === i.mode)
            return n.Kt.It = !1, void (n.Yt.It = !1); n.Kt.It = t && this.Jt.ti(this.yt), n.Yt.It = t && this.Jt.ii(), n.Kt.ct = i.horzLine.width, n.Kt.Gt = i.horzLine.style, n.Kt.R = i.horzLine.color, n.Yt.ct = i.vertLine.width, n.Yt.Gt = i.vertLine.style, n.Yt.R = i.vertLine.color, n._t = this.Jt.ni(), n.ut = this.Jt.si(); };
        return I;
    }());
    function V(t, i, n, s, e, r) { t.fillRect(i + r, n, s - 2 * r, r), t.fillRect(i + r, n + e - r, s - 2 * r, r), t.fillRect(i, n, r, e), t.fillRect(i + s - r, n, r, e); }
    function E(t, i, n, s, e, r) { t.save(), t.globalCompositeOperation = "copy", t.fillStyle = r, t.fillRect(i, n, s, e), t.restore(); }
    function B(t, i, n, s, e, r) { t.beginPath(), t.roundRect ? t.roundRect(i, n, s, e, r) : (t.lineTo(i + s - r[1], n), 0 !== r[1] && t.arcTo(i + s, n, i + s, n + r[1], r[1]), t.lineTo(i + s, n + e - r[2]), 0 !== r[2] && t.arcTo(i + s, n + e, i + s - r[2], n + e, r[2]), t.lineTo(i + r[3], n + e), 0 !== r[3] && t.arcTo(i, n + e, i, n + e - r[3], r[3]), t.lineTo(i, n + r[0]), 0 !== r[0] && t.arcTo(i, n, i + r[0], n, r[0])); }
    function A(t, i, n, s, e, r, h, a, l) {
        if (h === void 0) { h = 0; }
        if (a === void 0) { a = [0, 0, 0, 0]; }
        if (l === void 0) { l = ""; }
        if (t.save(), !h || !l || l === r)
            return B(t, i, n, s, e, a), t.fillStyle = r, t.fill(), void t.restore();
        var o = h / 2;
        var _;
        B(t, i + o, n + o, s - h, e - h, (_ = -o, a.map((function (t) { return 0 === t ? t : t + _; })))), "transparent" !== r && (t.fillStyle = r, t.fill()), "transparent" !== l && (t.lineWidth = h, t.strokeStyle = l, t.closePath(), t.stroke()), t.restore();
    }
    function z(t, i, n, s, e, r, h) { t.save(), t.globalCompositeOperation = "copy"; var a = t.createLinearGradient(0, 0, 0, e); a.addColorStop(0, r), a.addColorStop(1, h), t.fillStyle = a, t.fillRect(i, n, s, e), t.restore(); }
    var L = /** @class */ (function () {
        function L(t, i) {
            this.ht(t, i);
        }
        L.prototype.ht = function (t, i) { this.qt = t, this.ei = i; };
        L.prototype.$t = function (t, i) { return this.qt.It ? t.P + t.A + t.I : 0; };
        L.prototype.st = function (t, i, n, s) {
            var _this = this;
            if (!this.qt.It || 0 === this.qt.ri.length)
                return;
            var e = this.qt.R, r = this.ei.Z, h = t.useBitmapCoordinateSpace((function (t) { var h = t.context; h.font = i.k; var a = _this.hi(t, i, n, s), l = a.ai; return a.li ? A(h, l.oi, l._i, l.ui, l.ci, r, l.di, [l.ft, 0, 0, l.ft], r) : A(h, l.fi, l._i, l.ui, l.ci, r, l.di, [0, l.ft, l.ft, 0], r), _this.qt.pi && (h.fillStyle = e, h.fillRect(l.fi, l.mi, l.wi - l.fi, l.gi)), _this.qt.Mi && (h.fillStyle = i.D, h.fillRect(a.li ? l.bi - l.di : 0, l._i, l.di, l.Si - l._i)), a; }));
            t.useMediaCoordinateSpace((function (_j) {
                var t = _j.context;
                var n = h.xi;
                t.font = i.k, t.textAlign = h.li ? "right" : "left", t.textBaseline = "middle", t.fillStyle = e, t.fillText(_this.qt.ri, n.Ci, (n._i + n.Si) / 2 + n.yi);
            }));
        };
        L.prototype.hi = function (t, i, n, s) { var _j, _k; var e = t.context, r = t.bitmapSize, h = t.mediaSize, a = t.horizontalPixelRatio, l = t.verticalPixelRatio, o = this.qt.pi || !this.qt.Pi ? i.C : 0, _ = this.qt.ki ? i.S : 0, u = i.A + this.ei.Ti, c = i.I + this.ei.Ri, d = i.V, f = i.B, p = this.qt.ri, v = i.P, m = n.Di(e, p), w = Math.ceil(n.Ii(e, p)), g = v + u + c, M = i.S + d + f + w + o, b = Math.max(1, Math.floor(l)); var S = Math.round(g * l); S % 2 != b % 2 && (S += 1); var x = _ > 0 ? Math.max(1, Math.floor(_ * a)) : 0, C = Math.round(M * a), y = Math.round(o * a), P = (_k = (_j = this.ei.Vi) !== null && _j !== void 0 ? _j : this.ei.Ei) !== null && _k !== void 0 ? _k : this.ei.Bi, k = Math.round(P * l) - Math.floor(.5 * l), T = Math.floor(k + b / 2 - S / 2), R = T + S, D = "right" === s, I = D ? h.width - _ : _, V = D ? r.width - x : x; var E, B, A; return D ? (E = V - C, B = V - y, A = I - o - d - _) : (E = V + C, B = V + y, A = I + o + d), { li: D, ai: { _i: T, mi: k, Si: R, ui: C, ci: S, ft: 2 * a, di: x, oi: E, fi: V, wi: B, gi: b, bi: r.width }, xi: { _i: T / l, Si: R / l, Ci: A, yi: m } }; };
        return L;
    }());
    var O = /** @class */ (function () {
        function O(t) {
            this.Ai = { Bi: 0, Z: "#000", Ri: 0, Ti: 0 }, this.zi = { ri: "", It: !1, pi: !0, Pi: !1, Ht: "", R: "#FFF", Mi: !1, ki: !1 }, this.Li = { ri: "", It: !1, pi: !1, Pi: !0, Ht: "", R: "#FFF", Mi: !0, ki: !0 }, this.xt = !0, this.Oi = new (t || L)(this.zi, this.Ai), this.Ni = new (t || L)(this.Li, this.Ai);
        }
        O.prototype.ri = function () { return this.Fi(), this.zi.ri; };
        O.prototype.Bi = function () { return this.Fi(), this.Ai.Bi; };
        O.prototype.Pt = function () { this.xt = !0; };
        O.prototype.$t = function (t, i) {
            if (i === void 0) { i = !1; }
            return Math.max(this.Oi.$t(t, i), this.Ni.$t(t, i));
        };
        O.prototype.Wi = function () { var _j; return (_j = this.Ai.Vi) !== null && _j !== void 0 ? _j : null; };
        O.prototype.Hi = function () { var _j, _k; return (_k = (_j = this.Ai.Vi) !== null && _j !== void 0 ? _j : this.Ai.Ei) !== null && _k !== void 0 ? _k : this.Bi(); };
        O.prototype.Ui = function (t) { this.Ai.Ei = t !== null && t !== void 0 ? t : void 0; };
        O.prototype.$i = function () { return this.Fi(), this.zi.It || this.Li.It; };
        O.prototype.ji = function () { return this.Fi(), this.zi.It; };
        O.prototype.Tt = function (t) { return this.Fi(), this.zi.pi = this.zi.pi && t.N().ticksVisible, this.Li.pi = this.Li.pi && t.N().ticksVisible, this.Oi.ht(this.zi, this.Ai), this.Ni.ht(this.Li, this.Ai), this.Oi; };
        O.prototype.qi = function () { return this.Fi(), this.Oi.ht(this.zi, this.Ai), this.Ni.ht(this.Li, this.Ai), this.Ni; };
        O.prototype.Fi = function () { this.xt && (this.zi.pi = !0, this.Li.pi = !1, this.Yi(this.zi, this.Li, this.Ai)); };
        return O;
    }());
    var N = /** @class */ (function (_super) {
        __extends(N, _super);
        function N(t, i, n) {
            var _this = this;
            _this = _super.call(this) || this, _this.Jt = t, _this.Ki = i, _this.Gi = n;
            return _this;
        }
        N.prototype.Yi = function (t, i, n) { if (t.It = !1, 2 === this.Jt.N().mode)
            return; var s = this.Jt.N().horzLine; if (!s.labelVisible)
            return; var e = this.Ki.zt(); if (!this.Jt.It() || this.Ki.Zi() || null === e)
            return; var r = this.Ki.Xi().G(s.labelBackgroundColor); n.Z = r.Z, t.R = r.X; var h = 2 / 12 * this.Ki.P(); n.Ti = h, n.Ri = h; var a = this.Gi(this.Ki); n.Bi = a.Bi, t.ri = this.Ki.Ji(a.gt, e), t.It = !0; };
        return N;
    }(O));
    var F = /[1-9]/g;
    var W = /** @class */ (function () {
        function W() {
            this.qt = null;
        }
        W.prototype.ht = function (t) { this.qt = t; };
        W.prototype.st = function (t, i) {
            var _this = this;
            if (null === this.qt || !1 === this.qt.It || 0 === this.qt.ri.length)
                return;
            var n = t.useMediaCoordinateSpace((function (_j) {
                var t = _j.context;
                return (t.font = i.k, Math.round(i.Qi.Ii(t, a(_this.qt).ri, F)));
            }));
            if (n <= 0)
                return;
            var s = i.tn, e = n + 2 * s, r = e / 2, h = this.qt.nn;
            var l = this.qt.Bi, o = Math.floor(l - r) + .5;
            o < 0 ? (l += Math.abs(0 - o), o = Math.floor(l - r) + .5) : o + e > h && (l -= Math.abs(h - (o + e)), o = Math.floor(l - r) + .5);
            var _ = o + e, u = Math.ceil(0 + i.S + i.C + i.A + i.P + i.I);
            t.useBitmapCoordinateSpace((function (_j) {
                var t = _j.context, n = _j.horizontalPixelRatio, s = _j.verticalPixelRatio;
                var e = a(_this.qt);
                t.fillStyle = e.Z;
                var r = Math.round(o * n), h = Math.round(0 * s), l = Math.round(_ * n), c = Math.round(u * s), d = Math.round(2 * n);
                if (t.beginPath(), t.moveTo(r, h), t.lineTo(r, c - d), t.arcTo(r, c, r + d, c, d), t.lineTo(l - d, c), t.arcTo(l, c, l, c - d, d), t.lineTo(l, h), t.fill(), e.pi) {
                    var r_1 = Math.round(e.Bi * n), a_2 = h, l_2 = Math.round((a_2 + i.C) * s);
                    t.fillStyle = e.R;
                    var o_2 = Math.max(1, Math.floor(n)), _2 = Math.floor(.5 * n);
                    t.fillRect(r_1 - _2, a_2, o_2, l_2 - a_2);
                }
            })), t.useMediaCoordinateSpace((function (_j) {
                var t = _j.context;
                var n = a(_this.qt), e = 0 + i.S + i.C + i.A + i.P / 2;
                t.font = i.k, t.textAlign = "left", t.textBaseline = "middle", t.fillStyle = n.R;
                var r = i.Qi.Di(t, "Apr0");
                t.translate(o + s, e + r), t.fillText(n.ri, 0, 0);
            }));
        };
        return W;
    }());
    var H = /** @class */ (function () {
        function H(t, i, n) {
            this.xt = !0, this.Xt = new W, this.Zt = { It: !1, Z: "#4c525e", R: "white", ri: "", nn: 0, Bi: NaN, pi: !0 }, this.Ct = t, this.sn = i, this.Gi = n;
        }
        H.prototype.Pt = function () { this.xt = !0; };
        H.prototype.Tt = function () { return this.xt && (this.Rt(), this.xt = !1), this.Xt.ht(this.Zt), this.Xt; };
        H.prototype.Rt = function () { var t = this.Zt; if (t.It = !1, 2 === this.Ct.N().mode)
            return; var i = this.Ct.N().vertLine; if (!i.labelVisible)
            return; var n = this.sn.Bt(); if (n.Zi())
            return; t.nn = n.nn(); var s = this.Gi(); if (null === s)
            return; t.Bi = s.Bi; var e = n.en(this.Ct.Et()); t.ri = n.rn(a(e)), t.It = !0; var r = this.sn.Xi().G(i.labelBackgroundColor); t.Z = r.Z, t.R = r.X, t.pi = n.N().ticksVisible; };
        return H;
    }());
    var U = /** @class */ (function () {
        function U() {
            this.hn = null, this.an = 0;
        }
        U.prototype.ln = function () { return this.an; };
        U.prototype._n = function (t) { this.an = t; };
        U.prototype.Ft = function () { return this.hn; };
        U.prototype.un = function (t) { this.hn = t; };
        U.prototype.cn = function (t) { return []; };
        U.prototype.dn = function () { return []; };
        U.prototype.It = function () { return !0; };
        return U;
    }());
    var $;
    !function (t) { t[t.Normal = 0] = "Normal", t[t.Magnet = 1] = "Magnet", t[t.Hidden = 2] = "Hidden", t[t.MagnetOHLC = 3] = "MagnetOHLC"; }($ || ($ = {}));
    var j = /** @class */ (function (_super) {
        __extends(j, _super);
        function j(t, i) {
            var _this = this;
            _this = _super.call(this) || this, _this.yt = null, _this.fn = NaN, _this.pn = 0, _this.vn = !1, _this.mn = new Map, _this.wn = !1, _this.gn = new WeakMap, _this.Mn = new WeakMap, _this.bn = NaN, _this.Sn = NaN, _this.xn = NaN, _this.Cn = NaN, _this.sn = t, _this.yn = i;
            _this.Pn = (function (t, i) { return function (n) { var s = i(), e = t(); if (n === a(_this.yt).kn())
                return { gt: e, Bi: s }; {
                var t_1 = a(n.zt());
                return { gt: n.Tn(s, t_1), Bi: s };
            } }; })((function () { return _this.fn; }), (function () { return _this.Sn; }));
            var n = (function (t, i) { return function () { var n = _this.sn.Bt().Rn(t()), s = i(); return n && Number.isFinite(s) ? { wt: n, Bi: s } : null; }; })((function () { return _this.pn; }), (function () { return _this.ni(); }));
            _this.Dn = new H(_this, t, n);
            return _this;
        }
        j.prototype.N = function () { return this.yn; };
        j.prototype.In = function (t, i) { this.xn = t, this.Cn = i; };
        j.prototype.Vn = function () { this.xn = NaN, this.Cn = NaN; };
        j.prototype.En = function () { return this.xn; };
        j.prototype.Bn = function () { return this.Cn; };
        j.prototype.An = function (t, i, n) { this.wn || (this.wn = !0), this.vn = !0, this.zn(t, i, n); };
        j.prototype.Et = function () { return this.pn; };
        j.prototype.ni = function () { return this.bn; };
        j.prototype.si = function () { return this.Sn; };
        j.prototype.It = function () { return this.vn; };
        j.prototype.Ln = function () { this.vn = !1, this.On(), this.fn = NaN, this.bn = NaN, this.Sn = NaN, this.yt = null, this.Vn(), this.Nn(); };
        j.prototype.Fn = function (t) { if (!this.yn.doNotSnapToHiddenSeriesIndices)
            return t; var i = this.sn, n = i.Bt(); var s = null, e = null; for (var _j = 0, _k = i.Wn(); _j < _k.length; _j++) {
            var n_3 = _k[_j];
            var i_4 = n_3.Un().Hn(t, -1);
            if (i_4) {
                if (i_4.$n === t)
                    return t;
                (null === s || i_4.$n > s) && (s = i_4.$n);
            }
            var r_2 = n_3.Un().Hn(t, 1);
            if (r_2) {
                if (r_2.$n === t)
                    return t;
                (null === e || r_2.$n < e) && (e = r_2.$n);
            }
        } var r = [s, e].filter(v); if (0 === r.length)
            return t; var h = n.jt(t), a = r.map((function (t) { return Math.abs(h - n.jt(t)); })); return r[a.indexOf(Math.min.apply(Math, a))]; };
        j.prototype.jn = function (t) { var i = this.gn.get(t); i || (i = new I(this, t), this.gn.set(t, i)); var n = this.Mn.get(t); return n || (n = new R(this.sn, this, t), this.Mn.set(t, n)), [i, n]; };
        j.prototype.ti = function (t) { return t === this.yt && this.yn.horzLine.visible; };
        j.prototype.ii = function () { return this.yn.vertLine.visible; };
        j.prototype.qn = function (t, i) { this.vn && this.yt === t || this.mn.clear(); var n = []; return this.yt === t && n.push(this.Yn(this.mn, i, this.Pn)), n; };
        j.prototype.dn = function () { return this.vn ? [this.Dn] : []; };
        j.prototype.Kn = function () { return this.yt; };
        j.prototype.Nn = function () {
            var _this = this;
            this.sn.Gn().forEach((function (t) { var _j, _k; (_j = _this.gn.get(t)) === null || _j === void 0 ? void 0 : _j.Pt(), (_k = _this.Mn.get(t)) === null || _k === void 0 ? void 0 : _k.Pt(); })), this.mn.forEach((function (t) { return t.Pt(); })), this.Dn.Pt();
        };
        j.prototype.Zn = function (t) { return t && !t.kn().Zi() ? t.kn() : null; };
        j.prototype.zn = function (t, i, n) { this.Xn(t, i, n) && this.Nn(); };
        j.prototype.Xn = function (t, i, n) { var s = this.bn, e = this.Sn, r = this.fn, h = this.pn, a = this.yt, l = this.Zn(n); this.pn = t, this.bn = isNaN(t) ? NaN : this.sn.Bt().jt(t), this.yt = n; var o = null !== l ? l.zt() : null; return null !== l && null !== o ? (this.fn = i, this.Sn = l.Nt(i, o)) : (this.fn = NaN, this.Sn = NaN), s !== this.bn || e !== this.Sn || h !== this.pn || r !== this.fn || a !== this.yt; };
        j.prototype.On = function () { var t = this.sn.Jn().map((function (t) { return t.Un().Qn(); })).filter(v), i = 0 === t.length ? null : Math.max.apply(Math, t); this.pn = null !== i ? i : NaN; };
        j.prototype.Yn = function (t, i, n) { var s = t.get(i); return void 0 === s && (s = new N(this, i, n), t.set(i, s)), s; };
        return j;
    }(U));
    function q(t) { return "left" === t || "right" === t; }
    var Y = /** @class */ (function () {
        function Y(t) {
            this.ts = new Map, this.ns = [], this.ss = t;
        }
        Y.prototype.es = function (t, i) { var n = function (t, i) { return void 0 === t ? i : { rs: Math.max(t.rs, i.rs), hs: t.hs || i.hs }; }(this.ts.get(t), i); this.ts.set(t, n); };
        Y.prototype.ls = function () { return this.ss; };
        Y.prototype._s = function (t) { var i = this.ts.get(t); return void 0 === i ? { rs: this.ss } : { rs: Math.max(this.ss, i.rs), hs: i.hs }; };
        Y.prototype.us = function () { this.cs(), this.ns = [{ ds: 0 }]; };
        Y.prototype.fs = function (t) { this.cs(), this.ns = [{ ds: 1, Wt: t }]; };
        Y.prototype.ps = function (t) { this.vs(), this.ns.push({ ds: 5, Wt: t }); };
        Y.prototype.cs = function () { this.vs(), this.ns.push({ ds: 6 }); };
        Y.prototype.ws = function () { this.cs(), this.ns = [{ ds: 4 }]; };
        Y.prototype.gs = function (t) { this.cs(), this.ns.push({ ds: 2, Wt: t }); };
        Y.prototype.Ms = function (t) { this.cs(), this.ns.push({ ds: 3, Wt: t }); };
        Y.prototype.bs = function () { return this.ns; };
        Y.prototype.Ss = function (t) {
            var _this = this;
            for (var _j = 0, _k = t.ns; _j < _k.length; _j++) {
                var i_5 = _k[_j];
                this.xs(i_5);
            }
            this.ss = Math.max(this.ss, t.ss), t.ts.forEach((function (t, i) { _this.es(i, t); }));
        };
        Y.Cs = function () { return new Y(2); };
        Y.ys = function () { return new Y(3); };
        Y.prototype.xs = function (t) { switch (t.ds) {
            case 0:
                this.us();
                break;
            case 1:
                this.fs(t.Wt);
                break;
            case 2:
                this.gs(t.Wt);
                break;
            case 3:
                this.Ms(t.Wt);
                break;
            case 4:
                this.ws();
                break;
            case 5:
                this.ps(t.Wt);
                break;
            case 6: this.vs();
        } };
        Y.prototype.vs = function () { var t = this.ns.findIndex((function (t) { return 5 === t.ds; })); -1 !== t && this.ns.splice(t, 1); };
        return Y;
    }());
    var K = /** @class */ (function () {
        function K() {
        }
        K.prototype.formatTickmarks = function (t) {
            var _this = this;
            return t.map((function (t) { return _this.format(t); }));
        };
        return K;
    }());
    var G = ".";
    function Z(t, i) { if (!u(t))
        return "n/a"; if (!c(i))
        throw new TypeError("invalid length"); if (i < 0 || i > 16)
        throw new TypeError("invalid length"); if (0 === i)
        return t.toString(); return ("0000000000000000" + t.toString()).slice(-i); }
    var X = /** @class */ (function (_super) {
        __extends(X, _super);
        function X(t, i) {
            var _this = this;
            if (_this = _super.call(this) || this, i || (i = 1), u(t) && c(t) || (t = 100), t < 0)
                throw new TypeError("invalid base");
            _this.Ki = t, _this.Ps = i, _this.ks();
            return _this;
        }
        X.prototype.format = function (t) { var i = t < 0 ? "−" : ""; return t = Math.abs(t), i + this.Ts(t); };
        X.prototype.ks = function () { if (this.Rs = 0, this.Ki > 0 && this.Ps > 0) {
            var t_2 = this.Ki;
            for (; t_2 > 1;)
                t_2 /= 10, this.Rs++;
        } };
        X.prototype.Ts = function (t) { var i = this.Ki / this.Ps; var n = Math.floor(t), s = ""; var e = void 0 !== this.Rs ? this.Rs : NaN; if (i > 1) {
            var r_3 = +(Math.round(t * i) - n * i).toFixed(this.Rs);
            r_3 >= i && (r_3 -= i, n += 1), s = G + Z(+r_3.toFixed(this.Rs) * this.Ps, e);
        }
        else
            n = Math.round(n * i) / i, e > 0 && (s = G + Z(0, e)); return n.toFixed(0) + s; };
        return X;
    }(K));
    var J = /** @class */ (function (_super) {
        __extends(J, _super);
        function J(t) {
            if (t === void 0) { t = 100; }
            return _super.call(this, t) || this;
        }
        J.prototype.format = function (t) { return "".concat(_super.prototype.format.call(this, t), "%"); };
        return J;
    }(X));
    var Q = /** @class */ (function (_super) {
        __extends(Q, _super);
        function Q(t) {
            var _this = this;
            _this = _super.call(this) || this, _this.Ds = t;
            return _this;
        }
        Q.prototype.format = function (t) { var i = ""; return t < 0 && (i = "-", t = -t), t < 995 ? i + this.Is(t) : t < 999995 ? i + this.Is(t / 1e3) + "K" : t < 999999995 ? (t = 1e3 * Math.round(t / 1e3), i + this.Is(t / 1e6) + "M") : (t = 1e6 * Math.round(t / 1e6), i + this.Is(t / 1e9) + "B"); };
        Q.prototype.Is = function (t) { var i; var n = Math.pow(10, this.Ds); return i = (t = Math.round(t * n) / n) >= 1e-15 && t < 1 ? t.toFixed(this.Ds).replace(/\.?0+$/, "") : String(t), i.replace(/(\.[1-9]*)0+$/, (function (t, i) { return i; })); };
        return Q;
    }(K));
    var tt = /[2-9]/g;
    var it = /** @class */ (function () {
        function it(t) {
            if (t === void 0) { t = 50; }
            this.Vs = 0, this.Es = 1, this.Bs = 1, this.As = {}, this.zs = new Map, this.Ls = t;
        }
        it.prototype.Os = function () { this.Vs = 0, this.zs.clear(), this.Es = 1, this.Bs = 1, this.As = {}; };
        it.prototype.Ii = function (t, i, n) { return this.Ns(t, i, n).width; };
        it.prototype.Di = function (t, i, n) { var s = this.Ns(t, i, n); return ((s.actualBoundingBoxAscent || 0) - (s.actualBoundingBoxDescent || 0)) / 2; };
        it.prototype.Ns = function (t, i, n) { var s = n || tt, e = String(i).replace(s, "0"); if (this.zs.has(e))
            return h(this.zs.get(e)).Fs; if (this.Vs === this.Ls) {
            var t_3 = this.As[this.Bs];
            delete this.As[this.Bs], this.zs.delete(t_3), this.Bs++, this.Vs--;
        } t.save(), t.textBaseline = "middle"; var r = t.measureText(e); return t.restore(), 0 === r.width && i.length || (this.zs.set(e, { Fs: r, Ws: this.Es }), this.As[this.Es] = e, this.Vs++, this.Es++), r; };
        return it;
    }());
    var nt = /** @class */ (function () {
        function nt(t) {
            this.Hs = null, this.M = null, this.Us = "right", this.$s = t;
        }
        nt.prototype.js = function (t, i, n) { this.Hs = t, this.M = i, this.Us = n; };
        nt.prototype.st = function (t) { null !== this.M && null !== this.Hs && this.Hs.st(t, this.M, this.$s, this.Us); };
        return nt;
    }());
    var st = /** @class */ (function () {
        function st(t, i, n) {
            this.qs = t, this.$s = new it(50), this.Ys = i, this.O = n, this.F = -1, this.Xt = new nt(this.$s);
        }
        st.prototype.Tt = function () { var t = this.O.Ks(this.Ys); if (null === t)
            return null; var i = t.Gs(this.Ys) ? t.Zs() : this.Ys.Ft(); if (null === i)
            return null; var n = t.Xs(i); if ("overlay" === n)
            return null; var s = this.O.Js(); return s.P !== this.F && (this.F = s.P, this.$s.Os()), this.Xt.js(this.qs.qi(), s, n), this.Xt; };
        return st;
    }());
    var et = /** @class */ (function (_super) {
        __extends(et, _super);
        function et() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.qt = null;
            return _this;
        }
        et.prototype.ht = function (t) { this.qt = t; };
        et.prototype.Qs = function (t, i) { var _j; if (!((_j = this.qt) === null || _j === void 0 ? void 0 : _j.It))
            return null; var _k = this.qt, n = _k.ut, s = _k.ct, e = _k.te; return i >= n - s - 7 && i <= n + s + 7 ? { ie: this.qt, ne: Math.abs(i - n), se: 2, ee: "price-line", te: e } : null; };
        et.prototype.et = function (_j) {
            var t = _j.context, i = _j.bitmapSize, n = _j.horizontalPixelRatio, r = _j.verticalPixelRatio;
            if (null === this.qt)
                return;
            if (!1 === this.qt.It)
                return;
            var h = Math.round(this.qt.ut * r);
            h < 0 || h > i.height || (t.lineCap = "butt", t.strokeStyle = this.qt.R, t.lineWidth = Math.floor(this.qt.ct * n), s(t, this.qt.Gt), e(t, h, 0, i.width));
        };
        return et;
    }(y));
    var rt = /** @class */ (function () {
        function rt(t) {
            this.re = { ut: 0, R: "rgba(0, 0, 0, 0)", ct: 1, Gt: 0, It: !1 }, this.he = new et, this.xt = !0, this.ae = t, this.le = t.Qt(), this.he.ht(this.re);
        }
        rt.prototype.Pt = function () { this.xt = !0; };
        rt.prototype.Tt = function () { return this.ae.It() ? (this.xt && (this.oe(), this.xt = !1), this.he) : null; };
        return rt;
    }());
    var ht = /** @class */ (function (_super) {
        __extends(ht, _super);
        function ht(t) {
            return _super.call(this, t) || this;
        }
        ht.prototype.oe = function () { this.re.It = !1; var t = this.ae.Ft(), i = t._e()._e; if (2 !== i && 3 !== i)
            return; var n = this.ae.N(); if (!n.baseLineVisible || !this.ae.It())
            return; var s = this.ae.zt(); null !== s && (this.re.It = !0, this.re.ut = t.Nt(s.Wt, s.Wt), this.re.R = n.baseLineColor, this.re.ct = n.baseLineWidth, this.re.Gt = n.baseLineStyle); };
        return ht;
    }(rt));
    var at = /** @class */ (function (_super) {
        __extends(at, _super);
        function at() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.qt = null;
            return _this;
        }
        at.prototype.ht = function (t) { this.qt = t; };
        at.prototype.ue = function () { return this.qt; };
        at.prototype.et = function (_j) {
            var t = _j.context, i = _j.horizontalPixelRatio, n = _j.verticalPixelRatio;
            var s = this.qt;
            if (null === s)
                return;
            var e = Math.max(1, Math.floor(i)), r = e % 2 / 2, h = Math.round(s.ce.x * i) + r, a = s.ce.y * n;
            t.fillStyle = s.de, t.beginPath();
            var l = Math.max(2, 1.5 * s.fe) * i;
            t.arc(h, a, l, 0, 2 * Math.PI, !1), t.fill(), t.fillStyle = s.pe, t.beginPath(), t.arc(h, a, s.ft * i, 0, 2 * Math.PI, !1), t.fill(), t.lineWidth = e, t.strokeStyle = s.ve, t.beginPath(), t.arc(h, a, s.ft * i + e / 2, 0, 2 * Math.PI, !1), t.stroke();
        };
        return at;
    }(y));
    var lt = [{ me: 0, we: .25, ge: 4, Me: 10, be: .25, Se: 0, xe: .4, Ce: .8 }, { me: .25, we: .525, ge: 10, Me: 14, be: 0, Se: 0, xe: .8, Ce: 0 }, { me: .525, we: 1, ge: 14, Me: 14, be: 0, Se: 0, xe: 0, Ce: 0 }];
    var ot = /** @class */ (function () {
        function ot(t) {
            this.Xt = new at, this.xt = !0, this.ye = !0, this.Pe = performance.now(), this.ke = this.Pe - 1, this.Te = t;
        }
        ot.prototype.Re = function () { this.ke = this.Pe - 1, this.Pt(); };
        ot.prototype.De = function () { if (this.Pt(), 2 === this.Te.N().lastPriceAnimation) {
            var t_4 = performance.now(), i_6 = this.ke - t_4;
            if (i_6 > 0)
                return void (i_6 < 650 && (this.ke += 2600));
            this.Pe = t_4, this.ke = t_4 + 2600;
        } };
        ot.prototype.Pt = function () { this.xt = !0; };
        ot.prototype.Ie = function () { this.ye = !0; };
        ot.prototype.It = function () { return 0 !== this.Te.N().lastPriceAnimation; };
        ot.prototype.Ve = function () { switch (this.Te.N().lastPriceAnimation) {
            case 0: return !1;
            case 1: return !0;
            case 2: return performance.now() <= this.ke;
        } };
        ot.prototype.Tt = function () { return this.xt ? (this.Rt(), this.xt = !1, this.ye = !1) : this.ye && (this.Ee(), this.ye = !1), this.Xt; };
        ot.prototype.Rt = function () { this.Xt.ht(null); var t = this.Te.Qt().Bt(), i = t.Be(), n = this.Te.zt(); if (null === i || null === n)
            return; var s = this.Te.Ae(!0); if (s.ze || !i.Le(s.$n))
            return; var e = { x: t.jt(s.$n), y: this.Te.Ft().Nt(s.gt, n.Wt) }, r = s.R, h = this.Te.N().lineWidth, a = this.Oe(this.Ne(), r); this.Xt.ht({ de: r, fe: h, pe: a.pe, ve: a.ve, ft: a.ft, ce: e }); };
        ot.prototype.Ee = function () { var t = this.Xt.ue(); if (null !== t) {
            var i_7 = this.Oe(this.Ne(), t.de);
            t.pe = i_7.pe, t.ve = i_7.ve, t.ft = i_7.ft;
        } };
        ot.prototype.Ne = function () { return this.Ve() ? performance.now() - this.Pe : 2599; };
        ot.prototype.Fe = function (t, i, n, s) { var e = n + (s - n) * i; return this.Te.Qt().Xi().Y(t, e); };
        ot.prototype.Oe = function (t, i) { var n = t % 2600 / 2600; var s; for (var _j = 0, lt_1 = lt; _j < lt_1.length; _j++) {
            var t_5 = lt_1[_j];
            if (n >= t_5.me && n <= t_5.we) {
                s = t_5;
                break;
            }
        } r(void 0 !== s, "Last price animation internal logic error"); var e = (n - s.me) / (s.we - s.me); return { pe: this.Fe(i, e, s.be, s.Se), ve: this.Fe(i, e, s.xe, s.Ce), ft: (h = e, a = s.ge, l = s.Me, a + (l - a) * h) }; var h, a, l; };
        return ot;
    }());
    var _t = /** @class */ (function (_super) {
        __extends(_t, _super);
        function _t(t) {
            return _super.call(this, t) || this;
        }
        _t.prototype.oe = function () { var t = this.re; t.It = !1; var i = this.ae.N(); if (!i.priceLineVisible || !this.ae.It())
            return; var n = this.ae.Ae(0 === i.priceLineSource); n.ze || (t.It = !0, t.ut = n.Bi, t.R = this.ae.We(n.R), t.ct = i.priceLineWidth, t.Gt = i.priceLineStyle); };
        return _t;
    }(rt));
    var ut = /** @class */ (function (_super) {
        __extends(ut, _super);
        function ut(t) {
            var _this = this;
            _this = _super.call(this) || this, _this.Jt = t;
            return _this;
        }
        ut.prototype.Yi = function (t, i, n) { t.It = !1, i.It = !1; var s = this.Jt; if (!s.It())
            return; var e = s.N(), r = e.lastValueVisible, h = "" !== s.He(), a = 0 === e.seriesLastValueMode, l = s.Ae(!1); if (l.ze)
            return; r && (t.ri = this.Ue(l, r, a), t.It = 0 !== t.ri.length), (h || a) && (i.ri = this.$e(l, r, h, a), i.It = i.ri.length > 0); var o = s.We(l.R), _ = this.Jt.Qt().Xi().G(o); n.Z = _.Z, n.Bi = l.Bi, i.Ht = s.Qt().Ut(l.Bi / s.Ft().$t()), t.Ht = o, t.R = _.X, i.R = _.X; };
        ut.prototype.$e = function (t, i, n, s) { var e = ""; var r = this.Jt.He(); return n && 0 !== r.length && (e += "".concat(r, " ")), i && s && (e += this.Jt.Ft().je() ? t.qe : t.Ye), e.trim(); };
        ut.prototype.Ue = function (t, i, n) { return i ? n ? this.Jt.Ft().je() ? t.Ye : t.qe : t.ri : ""; };
        return ut;
    }(O));
    function ct(t, i, n, s) { var e = Number.isFinite(i), r = Number.isFinite(n); return e && r ? t(i, n) : e || r ? e ? i : n : s; }
    var dt = /** @class */ (function () {
        function dt(t, i) {
            this.Ke = t, this.Ge = i;
        }
        dt.prototype.Ze = function (t) { return null !== t && (this.Ke === t.Ke && this.Ge === t.Ge); };
        dt.prototype.Xe = function () { return new dt(this.Ke, this.Ge); };
        dt.prototype.Je = function () { return this.Ke; };
        dt.prototype.Qe = function () { return this.Ge; };
        dt.prototype.tr = function () { return this.Ge - this.Ke; };
        dt.prototype.Zi = function () { return this.Ge === this.Ke || Number.isNaN(this.Ge) || Number.isNaN(this.Ke); };
        dt.prototype.Ss = function (t) { return null === t ? this : new dt(ct(Math.min, this.Je(), t.Je(), -1 / 0), ct(Math.max, this.Qe(), t.Qe(), 1 / 0)); };
        dt.prototype.ir = function (t) { if (!u(t))
            return; if (0 === this.Ge - this.Ke)
            return; var i = .5 * (this.Ge + this.Ke); var n = this.Ge - i, s = this.Ke - i; n *= t, s *= t, this.Ge = i + n, this.Ke = i + s; };
        dt.prototype.nr = function (t) { u(t) && (this.Ge += t, this.Ke += t); };
        dt.prototype.sr = function () { return { minValue: this.Ke, maxValue: this.Ge }; };
        dt.er = function (t) { return null === t ? null : new dt(t.minValue, t.maxValue); };
        return dt;
    }());
    var ft = /** @class */ (function () {
        function ft(t, i) {
            this.rr = t, this.hr = i || null;
        }
        ft.prototype.ar = function () { return this.rr; };
        ft.prototype.lr = function () { return this.hr; };
        ft.prototype.sr = function () { return { priceRange: null === this.rr ? null : this.rr.sr(), margins: this.hr || void 0 }; };
        ft.er = function (t) { return null === t ? null : new ft(dt.er(t.priceRange), t.margins); };
        return ft;
    }());
    var pt = [2, 4, 8, 16, 32, 64, 128, 256, 512], vt = "Custom series with conflation reducer must have a priceValueBuilder method";
    var mt = /** @class */ (function (_super) {
        __extends(mt, _super);
        function mt(t, i) {
            var _this = this;
            _this = _super.call(this, t) || this, _this._r = i;
            return _this;
        }
        mt.prototype.oe = function () { var t = this.re; t.It = !1; var i = this._r.N(); if (!this.ae.It() || !i.lineVisible)
            return; var n = this._r.ur(); null !== n && (t.It = !0, t.ut = n, t.R = i.color, t.ct = i.lineWidth, t.Gt = i.lineStyle, t.te = this._r.N().id); };
        return mt;
    }(rt));
    var wt = /** @class */ (function (_super) {
        __extends(wt, _super);
        function wt(t, i) {
            var _this = this;
            _this = _super.call(this) || this, _this.Te = t, _this._r = i;
            return _this;
        }
        wt.prototype.Yi = function (t, i, n) { t.It = !1, i.It = !1; var s = this._r.N(), e = s.axisLabelVisible, r = "" !== s.title, h = this.Te; if (!e || !h.It())
            return; var a = this._r.ur(); if (null === a)
            return; r && (i.ri = s.title, i.It = !0), i.Ht = h.Qt().Ut(a / h.Ft().$t()), t.ri = this.cr(s.price), t.It = !0; var l = this.Te.Qt().Xi().G(s.axisLabelColor || s.color); n.Z = l.Z; var o = s.axisLabelTextColor || l.X; t.R = o, i.R = o, n.Bi = a; };
        wt.prototype.cr = function (t) { var i = this.Te.zt(); return null === i ? "" : this.Te.Ft().Ji(t, i.Wt); };
        return wt;
    }(O));
    var gt = /** @class */ (function () {
        function gt(t, i) {
            this.Te = t, this.yn = i, this.dr = new mt(t, this), this.qs = new wt(t, this), this.pr = new st(this.qs, t, t.Qt());
        }
        gt.prototype.vr = function (t) { _(this.yn, t), this.Pt(), this.Te.Qt().mr(); };
        gt.prototype.N = function () { return this.yn; };
        gt.prototype.wr = function () { return this.dr; };
        gt.prototype.gr = function () { return this.pr; };
        gt.prototype.Mr = function () { return this.qs; };
        gt.prototype.Pt = function () { this.dr.Pt(), this.qs.Pt(); };
        gt.prototype.ur = function () { var t = this.Te, i = t.Ft(); if (t.Qt().Bt().Zi() || i.Zi())
            return null; var n = t.zt(); return null === n ? null : i.Nt(this.yn.price, n.Wt); };
        return gt;
    }());
    var Mt = /** @class */ (function () {
        function Mt() {
            this.br = new WeakMap;
        }
        Mt.prototype.Sr = function (t, i, n) { var s = 1 / i * n; if (t >= s)
            return 1; var e = s / t, r = Math.pow(2, Math.floor(Math.log2(e))); return Math.min(r, 512); };
        Mt.prototype.Cr = function (t, i, n, s, e) {
            if (s === void 0) { s = !1; }
            if (0 === t.length || i <= 1)
                return t;
            var r = this.yr(i);
            if (r <= 1)
                return t;
            var h = this.Pr(t);
            var a = h.kr.get(r);
            return void 0 !== a || (a = this.Tr(t, r, n, s, e, h.kr), h.kr.set(r, a)), a;
        };
        Mt.prototype.Rr = function (t, i, n, s, e, r) {
            if (e === void 0) { e = !1; }
            if (n < 1 || 0 === t.length)
                return t;
            var h = this.Pr(t), a = h.kr.get(n);
            if (!a)
                return this.Cr(t, n, s, e, r);
            var l = this.Dr(t, i, n, a, e, s, r);
            return h.kr.set(n, l), l;
        };
        Mt.prototype.yr = function (t) { if (t <= 2)
            return 2; for (var _j = 0, pt_1 = pt; _j < pt_1.length; _j++) {
            var i_8 = pt_1[_j];
            if (t <= i_8)
                return i_8;
        } return 512; };
        Mt.prototype.Ir = function (t) { if (0 === t.length)
            return 0; var i = t[0], n = t[t.length - 1]; return 31 * t.length + 17 * i.$n + 13 * n.$n; };
        Mt.prototype.Tr = function (t, i, n, s, e, r) {
            if (s === void 0) { s = !1; }
            if (r === void 0) { r = new Map; }
            if (2 === i)
                return this.Vr(t, 2, n, s, e);
            var h = i / 2;
            var a = r.get(h);
            return a || (a = this.Tr(t, h, n, s, e, r), r.set(h, a)), this.Er(a, n, s, e);
        };
        Mt.prototype.Vr = function (t, i, n, s, e) {
            if (s === void 0) { s = !1; }
            var r = this.Br(t, i, n, s, e);
            return this.Ar(r, s);
        };
        Mt.prototype.Er = function (t, i, n, s) {
            if (n === void 0) { n = !1; }
            var e = this.Br(t, 2, i, n, s);
            return this.Ar(e, n);
        };
        Mt.prototype.Br = function (t, i, n, s, e) {
            if (s === void 0) { s = !1; }
            var r = [];
            for (var h_1 = 0; h_1 < t.length; h_1 += i) {
                if (t.length - h_1 >= i) {
                    var i_9 = this.zr(t[h_1], t[h_1 + 1], n, s, e);
                    i_9.Lr = !1, r.push(i_9);
                }
                else if (0 === r.length)
                    r.push(this.Or(t[h_1], !0));
                else {
                    var i_10 = r[r.length - 1];
                    r[r.length - 1] = this.Nr(i_10, t[h_1], n, s, e);
                }
            }
            return r;
        };
        Mt.prototype.Fr = function (t, i) { return (t !== null && t !== void 0 ? t : 1) + (i !== null && i !== void 0 ? i : 1); };
        Mt.prototype.zr = function (t, i, n, s, e) {
            if (s === void 0) { s = !1; }
            if (!s || !n || !e) {
                var n_4 = t.Wt[1] > i.Wt[1] ? t.Wt[1] : i.Wt[1], s_2 = t.Wt[2] < i.Wt[2] ? t.Wt[2] : i.Wt[2];
                return { Wr: t.$n, Hr: i.$n, Ur: t.wt, $r: i.wt, jr: t.Wt[0], qr: n_4, Yr: s_2, Kr: i.Wt[3], Gr: this.Fr(t.Gr, i.Gr), Zr: void 0, Lr: !1 };
            }
            var r = n(this.Xr(t, e), this.Xr(i, e)), h = e(r), a = h.length ? h[h.length - 1] : 0;
            return { Wr: t.$n, Hr: i.$n, Ur: t.wt, $r: i.wt, jr: t.Wt[0], qr: Math.max(t.Wt[1], a), Yr: Math.min(t.Wt[2], a), Kr: a, Gr: this.Fr(t.Gr, i.Gr), Zr: r, Lr: !1 };
        };
        Mt.prototype.Nr = function (t, i, n, s, e) {
            var _j, _k;
            if (s === void 0) { s = !1; }
            if (!s || !n || !e)
                return { Wr: t.Wr, Hr: i.$n, Ur: t.Ur, $r: i.wt, jr: t.jr, qr: t.qr > i.Wt[1] ? t.qr : i.Wt[1], Yr: t.Yr < i.Wt[2] ? t.Yr : i.Wt[2], Kr: i.Wt[3], Gr: t.Gr + ((_j = i.Gr) !== null && _j !== void 0 ? _j : 1), Zr: t.Zr, Lr: !1 };
            var r = t.Zr, h = this.Xr(i, e), a = r ? { data: r, index: t.Wr, originalTime: t.Ur, time: t.Ur, priceValues: e(r) } : null, l = a ? n(a, h) : h.data, o = a ? e(l) : h.priceValues, _ = o.length ? o[o.length - 1] : 0;
            return { Wr: t.Wr, Hr: i.$n, Ur: t.Ur, $r: i.wt, jr: t.jr, qr: Math.max(t.qr, _), Yr: Math.min(t.Yr, _), Kr: _, Gr: t.Gr + ((_k = i.Gr) !== null && _k !== void 0 ? _k : 1), Zr: l, Lr: !1 };
        };
        Mt.prototype.Jr = function (t, i, n, s, e, r, h, a) {
            if (h === void 0) { h = !1; }
            var l = i === s ? e : t[i];
            if (n - i == 1)
                return this.Or(l, !0);
            var o = i + 1 === s ? e : t[i + 1];
            var _ = this.zr(l, o, r, h, a);
            for (var l_3 = i + 2; l_3 < n; l_3++) {
                var i_11 = l_3 === s ? e : t[l_3];
                _ = this.Nr(_, i_11, r, h, a);
            }
            return _;
        };
        Mt.prototype.Xr = function (t, i) { var _j; var n = (_j = t.ue) !== null && _j !== void 0 ? _j : {}; return { data: t.ue, index: t.$n, originalTime: t.Qr, time: t.wt, priceValues: i(n) }; };
        Mt.prototype.th = function (t, i) {
            if (i === void 0) { i = !1; }
            var n = !0 === i, s = !!t.Zr;
            return __assign({ $n: t.Wr, wt: t.Ur, Qr: t.Ur, Wt: [n ? t.Kr : t.jr, t.qr, t.Yr, t.Kr], Gr: t.Gr }, { ue: n ? s ? t.Zr : { wt: t.Ur } : void 0 });
        };
        Mt.prototype.Ar = function (t, i) {
            var _this = this;
            if (i === void 0) { i = !1; }
            return t.map((function (t) { return _this.th(t, i); }));
        };
        Mt.prototype.Dr = function (t, i, n, s, e, r, h) {
            if (e === void 0) { e = !1; }
            if (0 === s.length)
                return s;
            var a = t.length - 1, l = Math.floor(a / n) * n;
            if (Math.min(l + n, t.length) - l < n && t.length > n) {
                var s_3 = t.slice();
                return s_3[s_3.length - 1] = i, this.Cr(s_3, n, r, e, h);
            }
            if (Math.floor((a - 1) / n) === Math.floor(a / n) || 1 === s.length) {
                var o_3 = Math.min(l + n, t.length), _3 = o_3 - l;
                if (_3 <= 0)
                    return s;
                var u_1 = 1 === _3 ? this.Or(l === a ? i : t[l], !0) : this.Jr(t, l, o_3, a, i, r, e, h);
                return s[s.length - 1] = this.th(u_1, e), s;
            }
            {
                var s_4 = t.slice();
                return s_4[s_4.length - 1] = i, this.Cr(s_4, n, r, e, h);
            }
        };
        Mt.prototype.Or = function (t, i) {
            var _j;
            if (i === void 0) { i = !1; }
            return { Wr: t.$n, Hr: t.$n, Ur: t.wt, $r: t.wt, jr: t.Wt[0], qr: t.Wt[1], Yr: t.Wt[2], Kr: t.Wt[3], Gr: (_j = t.Gr) !== null && _j !== void 0 ? _j : 1, Zr: t.ue, Lr: i };
        };
        Mt.prototype.Pr = function (t) { var i = this.ih(t), n = this.Ir(t); return i.nh !== n && (i.kr.clear(), i.nh = n), i; };
        Mt.prototype.ih = function (t) { var i = this.br.get(t); return void 0 === i && (i = { nh: this.Ir(t), kr: new Map }, this.br.set(t, i)), i; };
        return Mt;
    }());
    var bt = /** @class */ (function (_super) {
        __extends(bt, _super);
        function bt(t) {
            var _this = this;
            _this = _super.call(this) || this, _this.sn = t;
            return _this;
        }
        bt.prototype.Qt = function () { return this.sn; };
        return bt;
    }(U));
    var St = { Bar: function (t, i, n, s) { var _j; var e = i.upColor, r = i.downColor, h = a(t(n, s)), o = l(h.Wt[0]) <= l(h.Wt[3]); return { sh: (_j = h.R) !== null && _j !== void 0 ? _j : (o ? e : r) }; }, Candlestick: function (t, i, n, s) { var _j, _k, _q; var e = i.upColor, r = i.downColor, h = i.borderUpColor, o = i.borderDownColor, _ = i.wickUpColor, u = i.wickDownColor, c = a(t(n, s)), d = l(c.Wt[0]) <= l(c.Wt[3]); return { sh: (_j = c.R) !== null && _j !== void 0 ? _j : (d ? e : r), eh: (_k = c.Ht) !== null && _k !== void 0 ? _k : (d ? h : o), rh: (_q = c.hh) !== null && _q !== void 0 ? _q : (d ? _ : u) }; }, Custom: function (t, i, n, s) { var _j; return ({ sh: (_j = a(t(n, s)).R) !== null && _j !== void 0 ? _j : i.color }); }, Area: function (t, i, n, s) { var _j, _k, _q, _y; var e = a(t(n, s)); return { sh: (_j = e.vt) !== null && _j !== void 0 ? _j : i.lineColor, vt: (_k = e.vt) !== null && _k !== void 0 ? _k : i.lineColor, ah: (_q = e.ah) !== null && _q !== void 0 ? _q : i.topColor, oh: (_y = e.oh) !== null && _y !== void 0 ? _y : i.bottomColor }; }, Baseline: function (t, i, n, s) { var _j, _k, _q, _y, _z, _0; var e = a(t(n, s)); return { sh: e.Wt[3] >= i.baseValue.price ? i.topLineColor : i.bottomLineColor, _h: (_j = e._h) !== null && _j !== void 0 ? _j : i.topLineColor, uh: (_k = e.uh) !== null && _k !== void 0 ? _k : i.bottomLineColor, dh: (_q = e.dh) !== null && _q !== void 0 ? _q : i.topFillColor1, fh: (_y = e.fh) !== null && _y !== void 0 ? _y : i.topFillColor2, ph: (_z = e.ph) !== null && _z !== void 0 ? _z : i.bottomFillColor1, mh: (_0 = e.mh) !== null && _0 !== void 0 ? _0 : i.bottomFillColor2 }; }, Line: function (t, i, n, s) { var _j, _k; var e = a(t(n, s)); return { sh: (_j = e.R) !== null && _j !== void 0 ? _j : i.color, vt: (_k = e.R) !== null && _k !== void 0 ? _k : i.color }; }, Histogram: function (t, i, n, s) { var _j; return ({ sh: (_j = a(t(n, s)).R) !== null && _j !== void 0 ? _j : i.color }); } };
    var xt = /** @class */ (function () {
        function xt(t) {
            var _this = this;
            this.wh = function (t, i) { return void 0 !== i ? i.Wt : _this.Te.Un().gh(t); }, this.Te = t, this.Mh = St[t.bh()];
        }
        xt.prototype.Sh = function (t, i) { return this.Mh(this.wh, this.Te.N(), t, i); };
        return xt;
    }());
    function Ct(t, i, n, s, e, r) {
        if (e === void 0) { e = 0; }
        if (r === void 0) { r = i.length; }
        var h = r - e;
        for (; 0 < h;) {
            var r_4 = h >> 1, a_3 = e + r_4;
            s(i[a_3], n) === t ? (e = a_3 + 1, h -= r_4 + 1) : h = r_4;
        }
        return e;
    }
    var yt = Ct.bind(null, !0), Pt = Ct.bind(null, !1);
    var kt;
    !function (t) { t[t.NearestLeft = -1] = "NearestLeft", t[t.None = 0] = "None", t[t.NearestRight = 1] = "NearestRight"; }(kt || (kt = {}));
    var Tt = 30;
    var Rt = /** @class */ (function () {
        function Rt() {
            this.xh = [], this.Ch = new Map, this.yh = new Map, this.Ph = [];
        }
        Rt.prototype.kh = function () { return this.Th() > 0 ? this.xh[this.xh.length - 1] : null; };
        Rt.prototype.Rh = function () { return this.Th() > 0 ? this.Dh(0) : null; };
        Rt.prototype.Qn = function () { return this.Th() > 0 ? this.Dh(this.xh.length - 1) : null; };
        Rt.prototype.Th = function () { return this.xh.length; };
        Rt.prototype.Zi = function () { return 0 === this.Th(); };
        Rt.prototype.Le = function (t) { return null !== this.Ih(t, 0); };
        Rt.prototype.gh = function (t) { return this.Hn(t); };
        Rt.prototype.Hn = function (t, i) {
            if (i === void 0) { i = 0; }
            var n = this.Ih(t, i);
            return null === n ? null : __assign(__assign({}, this.Vh(n)), { $n: this.Dh(n) });
        };
        Rt.prototype.Eh = function () { return this.xh; };
        Rt.prototype.Bh = function (t, i, n) { if (this.Zi())
            return null; var s = null; for (var _j = 0, n_5 = n; _j < n_5.length; _j++) {
            var e_1 = n_5[_j];
            s = Dt(s, this.Ah(t, i, e_1));
        } return s; };
        Rt.prototype.ht = function (t) { this.yh.clear(), this.Ch.clear(), this.xh = t, this.Ph = t.map((function (t) { return t.$n; })); };
        Rt.prototype.zh = function () { return this.Ph; };
        Rt.prototype.Dh = function (t) { return this.xh[t].$n; };
        Rt.prototype.Vh = function (t) { return this.xh[t]; };
        Rt.prototype.Ih = function (t, i) { var n = this.Lh(t); if (null === n && 0 !== i)
            switch (i) {
                case -1: return this.Oh(t);
                case 1: return this.Nh(t);
                default: throw new TypeError("Unknown search mode");
            } return n; };
        Rt.prototype.Oh = function (t) { var i = this.Fh(t); return i > 0 && (i -= 1), i !== this.xh.length && this.Dh(i) < t ? i : null; };
        Rt.prototype.Nh = function (t) { var i = this.Wh(t); return i !== this.xh.length && t < this.Dh(i) ? i : null; };
        Rt.prototype.Lh = function (t) { var i = this.Fh(t); return i === this.xh.length || t < this.xh[i].$n ? null : i; };
        Rt.prototype.Fh = function (t) { return yt(this.xh, t, (function (t, i) { return t.$n < i; })); };
        Rt.prototype.Wh = function (t) { return Pt(this.xh, t, (function (t, i) { return t.$n > i; })); };
        Rt.prototype.Hh = function (t, i, n) { var s = null; for (var e_2 = t; e_2 < i; e_2++) {
            var t_6 = this.xh[e_2].Wt[n];
            Number.isNaN(t_6) || (null === s ? s = { Uh: t_6, $h: t_6 } : (t_6 < s.Uh && (s.Uh = t_6), t_6 > s.$h && (s.$h = t_6)));
        } return s; };
        Rt.prototype.Ah = function (t, i, n) { if (this.Zi())
            return null; var s = null; var e = a(this.Rh()), r = a(this.Qn()), h = Math.max(t, e), l = Math.min(i, r), o = Math.ceil(h / Tt) * Tt, _ = Math.max(o, Math.floor(l / Tt) * Tt); {
            var t_7 = this.Fh(h), e_3 = this.Wh(Math.min(l, o, i));
            s = Dt(s, this.Hh(t_7, e_3, n));
        } var u = this.Ch.get(n); void 0 === u && (u = new Map, this.Ch.set(n, u)); for (var t_8 = Math.max(o + 1, h); t_8 < _; t_8 += Tt) {
            var i_12 = Math.floor(t_8 / Tt);
            var e_4 = u.get(i_12);
            if (void 0 === e_4) {
                var t_9 = this.Fh(i_12 * Tt), s_5 = this.Wh((i_12 + 1) * Tt - 1);
                e_4 = this.Hh(t_9, s_5, n), u.set(i_12, e_4);
            }
            s = Dt(s, e_4);
        } {
            var t_10 = this.Fh(_), i_13 = this.Wh(l);
            s = Dt(s, this.Hh(t_10, i_13, n));
        } return s; };
        return Rt;
    }());
    function Dt(t, i) { if (null === t)
        return i; if (null === i)
        return t; return { Uh: Math.min(t.Uh, i.Uh), $h: Math.max(t.$h, i.$h) }; }
    function It() { return new Rt; }
    var Vt = { setLineStyle: s };
    var Et = /** @class */ (function () {
        function Et(t) {
            this.jh = t;
        }
        Et.prototype.st = function (t, i, n) { this.jh.draw(t, Vt); };
        Et.prototype.qh = function (t, i, n) { var _j, _k; (_k = (_j = this.jh).drawBackground) === null || _k === void 0 ? void 0 : _k.call(_j, t, Vt); };
        return Et;
    }());
    var Bt = /** @class */ (function () {
        function Bt(t) {
            this.zs = null, this.Yh = t;
        }
        Bt.prototype.Tt = function () { var _j; var t = this.Yh.renderer(); if (null === t)
            return null; if (((_j = this.zs) === null || _j === void 0 ? void 0 : _j.Kh) === t)
            return this.zs.Gh; var i = new Et(t); return this.zs = { Kh: t, Gh: i }, i; };
        Bt.prototype.Zh = function () { var _j, _k, _q; return (_q = (_k = (_j = this.Yh).zOrder) === null || _k === void 0 ? void 0 : _k.call(_j)) !== null && _q !== void 0 ? _q : "normal"; };
        return Bt;
    }());
    var At = /** @class */ (function () {
        function At(t) {
            this.Xh = null, this.Jh = t;
        }
        At.prototype.Qh = function () { return this.Jh; };
        At.prototype.Nn = function () { var _j, _k; (_k = (_j = this.Jh).updateAllViews) === null || _k === void 0 ? void 0 : _k.call(_j); };
        At.prototype.jn = function () { var _j, _k, _q, _y; var t = (_q = (_k = (_j = this.Jh).paneViews) === null || _k === void 0 ? void 0 : _k.call(_j)) !== null && _q !== void 0 ? _q : []; if (((_y = this.Xh) === null || _y === void 0 ? void 0 : _y.Kh) === t)
            return this.Xh.Gh; var i = t.map((function (t) { return new Bt(t); })); return this.Xh = { Kh: t, Gh: i }, i; };
        At.prototype.Qs = function (t, i) { var _j, _k, _q; return (_q = (_k = (_j = this.Jh).hitTest) === null || _k === void 0 ? void 0 : _k.call(_j, t, i)) !== null && _q !== void 0 ? _q : null; };
        return At;
    }());
    var zt = /** @class */ (function (_super) {
        __extends(zt, _super);
        function zt() {
            return _super !== null && _super.apply(this, arguments) || this;
        }
        zt.prototype.cn = function () { return []; };
        return zt;
    }(At));
    var Lt = /** @class */ (function () {
        function Lt(t) {
            this.jh = t;
        }
        Lt.prototype.st = function (t, i, n) { this.jh.draw(t, Vt); };
        Lt.prototype.qh = function (t, i, n) { var _j, _k; (_k = (_j = this.jh).drawBackground) === null || _k === void 0 ? void 0 : _k.call(_j, t, Vt); };
        return Lt;
    }());
    var Ot = /** @class */ (function () {
        function Ot(t) {
            this.zs = null, this.Yh = t;
        }
        Ot.prototype.Tt = function () { var _j; var t = this.Yh.renderer(); if (null === t)
            return null; if (((_j = this.zs) === null || _j === void 0 ? void 0 : _j.Kh) === t)
            return this.zs.Gh; var i = new Lt(t); return this.zs = { Kh: t, Gh: i }, i; };
        Ot.prototype.Zh = function () { var _j, _k, _q; return (_q = (_k = (_j = this.Yh).zOrder) === null || _k === void 0 ? void 0 : _k.call(_j)) !== null && _q !== void 0 ? _q : "normal"; };
        return Ot;
    }());
    function Nt(t) { var _j, _k, _q, _y, _z; return { ri: t.text(), Bi: t.coordinate(), Vi: (_j = t.fixedCoordinate) === null || _j === void 0 ? void 0 : _j.call(t), R: t.textColor(), Z: t.backColor(), It: (_q = (_k = t.visible) === null || _k === void 0 ? void 0 : _k.call(t)) !== null && _q !== void 0 ? _q : !0, pi: (_z = (_y = t.tickVisible) === null || _y === void 0 ? void 0 : _y.call(t)) !== null && _z !== void 0 ? _z : !0 }; }
    var Ft = /** @class */ (function () {
        function Ft(t, i) {
            this.Xt = new W, this.ta = t, this.ia = i;
        }
        Ft.prototype.Tt = function () { return this.Xt.ht(__assign({ nn: this.ia.nn() }, Nt(this.ta))), this.Xt; };
        return Ft;
    }());
    var Wt = /** @class */ (function (_super) {
        __extends(Wt, _super);
        function Wt(t, i) {
            var _this = this;
            _this = _super.call(this) || this, _this.ta = t, _this.Ki = i;
            return _this;
        }
        Wt.prototype.Yi = function (t, i, n) { var s = Nt(this.ta); n.Z = s.Z, t.R = s.R; var e = 2 / 12 * this.Ki.P(); n.Ti = e, n.Ri = e, n.Bi = s.Bi, n.Vi = s.Vi, t.ri = s.ri, t.It = s.It, t.pi = s.pi; };
        return Wt;
    }(O));
    var Ht = /** @class */ (function (_super) {
        __extends(Ht, _super);
        function Ht(t, i) {
            var _this = this;
            _this = _super.call(this, t) || this, _this.na = null, _this.sa = null, _this.ea = null, _this.ra = null, _this.Te = i;
            return _this;
        }
        Ht.prototype.dn = function () { var _j, _k, _q, _y; var t = (_q = (_k = (_j = this.Jh).timeAxisViews) === null || _k === void 0 ? void 0 : _k.call(_j)) !== null && _q !== void 0 ? _q : []; if (((_y = this.na) === null || _y === void 0 ? void 0 : _y.Kh) === t)
            return this.na.Gh; var i = this.Te.Qt().Bt(), n = t.map((function (t) { return new Ft(t, i); })); return this.na = { Kh: t, Gh: n }, n; };
        Ht.prototype.qn = function () { var _j, _k, _q, _y; var t = (_q = (_k = (_j = this.Jh).priceAxisViews) === null || _k === void 0 ? void 0 : _k.call(_j)) !== null && _q !== void 0 ? _q : []; if (((_y = this.sa) === null || _y === void 0 ? void 0 : _y.Kh) === t)
            return this.sa.Gh; var i = this.Te.Ft(), n = t.map((function (t) { return new Wt(t, i); })); return this.sa = { Kh: t, Gh: n }, n; };
        Ht.prototype.ha = function () { var _j, _k, _q, _y; var t = (_q = (_k = (_j = this.Jh).priceAxisPaneViews) === null || _k === void 0 ? void 0 : _k.call(_j)) !== null && _q !== void 0 ? _q : []; if (((_y = this.ea) === null || _y === void 0 ? void 0 : _y.Kh) === t)
            return this.ea.Gh; var i = t.map((function (t) { return new Ot(t); })); return this.ea = { Kh: t, Gh: i }, i; };
        Ht.prototype.aa = function () { var _j, _k, _q, _y; var t = (_q = (_k = (_j = this.Jh).timeAxisPaneViews) === null || _k === void 0 ? void 0 : _k.call(_j)) !== null && _q !== void 0 ? _q : []; if (((_y = this.ra) === null || _y === void 0 ? void 0 : _y.Kh) === t)
            return this.ra.Gh; var i = t.map((function (t) { return new Ot(t); })); return this.ra = { Kh: t, Gh: i }, i; };
        Ht.prototype.la = function (t, i) { var _j, _k, _q; return (_q = (_k = (_j = this.Jh).autoscaleInfo) === null || _k === void 0 ? void 0 : _k.call(_j, t, i)) !== null && _q !== void 0 ? _q : null; };
        return Ht;
    }(At));
    function Ut(t, i, n, s) { t.forEach((function (t) { i(t).forEach((function (t) { t.Zh() === n && s.push(t); })); })); }
    function $t(t) { return t.jn(); }
    function jt(t) { return t.ha(); }
    function qt(t) { return t.aa(); }
    var Yt = ["Area", "Line", "Baseline"];
    var Kt = /** @class */ (function (_super) {
        __extends(Kt, _super);
        function Kt(t, i, n, s, e) {
            var _this = this;
            _this = _super.call(this, t) || this, _this.qt = It(), _this.dr = new _t(_this), _this.oa = [], _this._a = new ht(_this), _this.ua = null, _this.ca = null, _this.da = null, _this.fa = [], _this.pa = new Mt, _this.va = new Map, _this.ma = null, _this.yn = n, _this.wa = i;
            var r = new ut(_this);
            if (_this.mn = [r], _this.pr = new st(r, _this, t), Yt.includes(_this.wa) && (_this.ua = new ot(_this)), _this.ga(), _this.Yh = s(_this, _this.Qt(), e), "Custom" === _this.wa) {
                var t_11 = _this.Yh;
                t_11.Ma && _this.ba(t_11.Ma);
            }
            return _this;
        }
        Kt.prototype.m = function () { null !== this.da && clearTimeout(this.da); };
        Kt.prototype.We = function (t) { return this.yn.priceLineColor || t; };
        Kt.prototype.Ae = function (t) { var i = { ze: !0 }, n = this.Ft(); if (this.Qt().Bt().Zi() || n.Zi() || this.qt.Zi())
            return i; var s = this.Qt().Bt().Be(), e = this.zt(); if (null === s || null === e)
            return i; var r, h; if (t) {
            var t_12 = this.qt.kh();
            if (null === t_12)
                return i;
            r = t_12, h = t_12.$n;
        }
        else {
            var t_13 = this.qt.Hn(s.bi(), -1);
            if (null === t_13)
                return i;
            if (r = this.qt.gh(t_13.$n), null === r)
                return i;
            h = t_13.$n;
        } var a = r.Wt[3], l = this.Sa().Sh(h, { Wt: r }), o = n.Nt(a, e.Wt); return { ze: !1, gt: a, ri: n.Ji(a, e.Wt), qe: n.xa(a), Ye: n.Ca(a, e.Wt), R: l.sh, Bi: o, $n: h }; };
        Kt.prototype.Sa = function () { return null !== this.ca || (this.ca = new xt(this)), this.ca; };
        Kt.prototype.N = function () { return this.yn; };
        Kt.prototype.vr = function (t) { var i = this.Qt(), n = t.priceScaleId, s = t.visible, e = t.priceFormat; void 0 !== n && n !== this.yn.priceScaleId && i.ya(this, n), void 0 !== s && s !== this.yn.visible && i.Pa(); var r = void 0 !== t.conflationThresholdFactor; _(this.yn, t), Object.prototype.hasOwnProperty.call(t, "autoscaleInfoProvider") && void 0 === t.autoscaleInfoProvider && (this.yn.autoscaleInfoProvider = void 0), r && (this.va.clear(), this.Qt().mr()), void 0 !== e && (this.ga(), i.ka()), i.Ta(this), i.Ra(), this.Yh.Pt("options"); };
        Kt.prototype.ht = function (t, i) { this.qt.ht(t), this.va.clear(); var n = this.Qt().Bt().N(); n.enableConflation && n.precomputeConflationOnInit && this.Da(n.precomputeConflationPriority), this.Ia(), null !== this.ua && (i && i.Va ? this.ua.De() : 0 === t.length && this.ua.Re()); var s = this.Qt().Ks(this); this.Qt().Ea(s), this.Qt().Ta(this), this.Qt().Ra(), this.Qt().mr(); };
        Kt.prototype.Ia = function () { this.Yh.Pt("data"); };
        Kt.prototype.Ba = function (t) { var i = new gt(this, t); return this.oa.push(i), this.Qt().Ta(this), i; };
        Kt.prototype.Aa = function (t) { var i = this.oa.indexOf(t); -1 !== i && this.oa.splice(i, 1), this.Qt().Ta(this); };
        Kt.prototype.za = function () { return this.oa; };
        Kt.prototype.bh = function () { return this.wa; };
        Kt.prototype.zt = function () { var t = this.La(); return null === t ? null : { Wt: t.Wt[3], Oa: t.wt }; };
        Kt.prototype.La = function () { var t = this.Qt().Bt().Be(); if (null === t)
            return null; var i = t.Na(); return this.qt.Hn(i, 1); };
        Kt.prototype.Un = function () { return this.qt; };
        Kt.prototype.ba = function (t) { this.ma = t, this.va.clear(); };
        Kt.prototype.Fa = function () { return !!this.Qt().Bt().N().enableConflation && this.Wa() > 1; };
        Kt.prototype.Rr = function (t) {
            var _this = this;
            if (!this.Fa())
                return;
            var i = this.Wa();
            if (!this.va.has(i))
                return;
            var n = "Custom" === this.wa, s = n && this.ma || void 0, e = n && this.Yh.Ha ? function (t) { var i = t, n = _this.Yh.Ha(i); return Array.isArray(n) ? n : ["number" == typeof n ? n : 0]; } : void 0, r = this.pa.Rr(this.qt.Eh(), t, i, s, n, e), h = It();
            h.ht(r), this.va.set(i, h);
        };
        Kt.prototype.Ua = function () { var _j; var t = this.Qt().Bt().N().enableConflation; if ("Custom" === this.wa && null === this.ma)
            return this.qt; if (!t)
            return this.qt; var i = this.Wa(), n = this.va.get(i); if (n)
            return n; this.$a(i); return (_j = this.va.get(i)) !== null && _j !== void 0 ? _j : this.qt; };
        Kt.prototype.ja = function (t) { var i = this.qt.gh(t); return null === i ? null : "Bar" === this.wa || "Candlestick" === this.wa || "Custom" === this.wa ? { jr: i.Wt[0], qr: i.Wt[1], Yr: i.Wt[2], Kr: i.Wt[3] } : i.Wt[3]; };
        Kt.prototype.qa = function (t) {
            var _this = this;
            var i = [];
            Ut(this.fa, $t, "top", i);
            var n = this.ua;
            return null !== n && n.It() ? (null === this.da && n.Ve() && (this.da = setTimeout((function () { _this.da = null, _this.Qt().Ya(); }), 0)), n.Ie(), i.unshift(n), i) : i;
        };
        Kt.prototype.jn = function () { var t = []; this.Ka() || t.push(this._a), t.push(this.Yh, this.dr); var i = this.oa.map((function (t) { return t.wr(); })); return t.push.apply(t, i), Ut(this.fa, $t, "normal", t), t; };
        Kt.prototype.Ga = function () { var _j, _k, _q; var t = (_q = (_k = (_j = this.Yh).Ga) === null || _k === void 0 ? void 0 : _k.call(_j)) !== null && _q !== void 0 ? _q : null; if (null === t)
            return null; var i = []; this.Ka() || i.push(this._a), i.push.apply(i, t.Za), Ut(this.fa, $t, "normal", i); var n = []; n.push.apply(n, __spreadArray(__spreadArray([], t.qa, false), [this.dr], false)); var s = this.oa.map((function (t) { return t.wr(); })); return n.push.apply(n, s), { Za: i, qa: n }; };
        Kt.prototype.Xa = function () { return this.Ja($t, "bottom"); };
        Kt.prototype.Qa = function (t) { return this.Ja(jt, t); };
        Kt.prototype.tl = function (t) { return this.Ja(qt, t); };
        Kt.prototype.il = function (t, i) { return this.fa.map((function (n) { return n.Qs(t, i); })).filter((function (t) { return null !== t; })); };
        Kt.prototype.cn = function () { return __spreadArray([this.pr], this.oa.map((function (t) { return t.gr(); })), true); };
        Kt.prototype.qn = function (t, i) { if (i !== this.hn && !this.Ka())
            return []; var n = __spreadArray([], this.mn, true); for (var _j = 0, _k = this.oa; _j < _k.length; _j++) {
            var t_14 = _k[_j];
            n.push(t_14.Mr());
        } return this.fa.forEach((function (t) { n.push.apply(n, t.qn()); })), n; };
        Kt.prototype.dn = function () { var t = []; return this.fa.forEach((function (i) { t.push.apply(t, i.dn()); })), t; };
        Kt.prototype.la = function (t, i) {
            var _this = this;
            if (void 0 !== this.yn.autoscaleInfoProvider) {
                var n_6 = this.yn.autoscaleInfoProvider((function () { var n = _this.nl(t, i); return null === n ? null : n.sr(); }));
                return ft.er(n_6);
            }
            return this.nl(t, i);
        };
        Kt.prototype.Kh = function () { var _j; var t = this.yn.priceFormat; return (_j = t.base) !== null && _j !== void 0 ? _j : 1 / t.minMove; };
        Kt.prototype.sl = function () { return this.el; };
        Kt.prototype.Nn = function () { var _j; this.Yh.Pt(); for (var _k = 0, _q = this.mn; _k < _q.length; _k++) {
            var t_15 = _q[_k];
            t_15.Pt();
        } for (var _y = 0, _z = this.oa; _y < _z.length; _y++) {
            var t_16 = _z[_y];
            t_16.Pt();
        } this.dr.Pt(), this._a.Pt(), (_j = this.ua) === null || _j === void 0 ? void 0 : _j.Pt(), this.fa.forEach((function (t) { return t.Nn(); })); };
        Kt.prototype.Ft = function () { return a(_super.prototype.Ft.call(this)); };
        Kt.prototype.At = function (t) { if (!(("Line" === this.wa || "Area" === this.wa || "Baseline" === this.wa) && this.yn.crosshairMarkerVisible))
            return null; var i = this.qt.gh(t); if (null === i)
            return null; return { gt: i.Wt[3], ft: this.rl(), Ht: this.hl(), Ot: this.al(), Lt: this.ll(t) }; };
        Kt.prototype.He = function () { return this.yn.title; };
        Kt.prototype.It = function () { return this.yn.visible; };
        Kt.prototype.ol = function (t) { this.fa.push(new Ht(t, this)); };
        Kt.prototype._l = function (t) { this.fa = this.fa.filter((function (i) { return i.Qh() !== t; })); };
        Kt.prototype.ul = function () {
            var _this = this;
            if ("Custom" === this.wa)
                return function (t) { return _this.Yh.Ha(t); };
        };
        Kt.prototype.cl = function () {
            var _this = this;
            if ("Custom" === this.wa)
                return function (t) { return _this.Yh.dl(t); };
        };
        Kt.prototype.fl = function () { return this.qt.zh(); };
        Kt.prototype.Ka = function () { return !q(this.Ft().pl()); };
        Kt.prototype.nl = function (t, i) { if (!c(t) || !c(i) || this.qt.Zi())
            return null; var n = "Line" === this.wa || "Area" === this.wa || "Baseline" === this.wa || "Histogram" === this.wa ? [3] : [2, 1], s = this.qt.Bh(t, i, n); var e = null !== s ? new dt(s.Uh, s.$h) : null, r = null; if ("Histogram" === this.bh()) {
            var t_17 = this.yn.base, i_14 = new dt(t_17, t_17);
            e = null !== e ? e.Ss(i_14) : i_14;
        } return this.fa.forEach((function (n) { var s = n.la(t, i); if (s === null || s === void 0 ? void 0 : s.priceRange) {
            var t_18 = new dt(s.priceRange.minValue, s.priceRange.maxValue);
            e = null !== e ? e.Ss(t_18) : t_18;
        } (s === null || s === void 0 ? void 0 : s.margins) && (r = s.margins); })), new ft(e, r); };
        Kt.prototype.rl = function () { switch (this.wa) {
            case "Line":
            case "Area":
            case "Baseline": return this.yn.crosshairMarkerRadius;
        } return 0; };
        Kt.prototype.hl = function () { switch (this.wa) {
            case "Line":
            case "Area":
            case "Baseline": {
                var t_19 = this.yn.crosshairMarkerBorderColor;
                if (0 !== t_19.length)
                    return t_19;
            }
        } return null; };
        Kt.prototype.al = function () { switch (this.wa) {
            case "Line":
            case "Area":
            case "Baseline": return this.yn.crosshairMarkerBorderWidth;
        } return 0; };
        Kt.prototype.ll = function (t) { switch (this.wa) {
            case "Line":
            case "Area":
            case "Baseline": {
                var t_20 = this.yn.crosshairMarkerBackgroundColor;
                if (0 !== t_20.length)
                    return t_20;
            }
        } return this.Sa().Sh(t).sh; };
        Kt.prototype.ga = function () { var _j; switch (this.yn.priceFormat.type) {
            case "custom": {
                var t_21 = this.yn.priceFormat.formatter;
                this.el = { format: t_21, formatTickmarks: (_j = this.yn.priceFormat.tickmarksFormatter) !== null && _j !== void 0 ? _j : (function (i) { return i.map(t_21); }) };
                break;
            }
            case "volume":
                this.el = new Q(this.yn.priceFormat.precision);
                break;
            case "percent":
                this.el = new J(this.yn.priceFormat.precision);
                break;
            default: {
                var t_22 = Math.pow(10, this.yn.priceFormat.precision);
                this.el = new X(t_22, this.yn.priceFormat.minMove * t_22);
            }
        } null !== this.hn && this.hn.vl(); };
        Kt.prototype.Ja = function (t, i) { var n = []; return Ut(this.fa, t, i, n), n; };
        Kt.prototype.Wa = function () { var _j = this.Ml(), t = _j.ml, i = _j.wl, n = _j.gl; return this.pa.Sr(t, i, n); };
        Kt.prototype.Ml = function () { var _j, _k; var t = this.Qt().Bt(), i = t.ml(), n = window.devicePixelRatio || 1, s = t.N().conflationThresholdFactor; return { ml: i, wl: n, gl: (_k = (_j = this.yn.conflationThresholdFactor) !== null && _j !== void 0 ? _j : s) !== null && _k !== void 0 ? _k : 1 }; };
        Kt.prototype.bl = function (t) { var i = this.qt.Eh(); var n; if ("Custom" === this.wa && null !== this.ma) {
            var s_6 = this.ul();
            if (!s_6)
                throw new Error(vt);
            n = this.pa.Cr(i, t, this.ma, !0, (function (t) { return s_6(t); }));
        }
        else
            n = this.pa.Cr(i, t); var s = It(); return s.ht(n), s; };
        Kt.prototype.$a = function (t) { var i = this.bl(t); this.va.set(t, i); };
        Kt.prototype.Da = function (t) {
            var _this = this;
            var _j;
            if ("Custom" === this.wa && (null === this.ma || !this.ul()))
                return;
            this.va.clear();
            var i = this.Qt().Bt().Sl();
            var _loop_1 = function (n_7) {
                var i_16 = function () { _this.xl(n_7); }, s_7 = "object" == typeof window && window || "object" == typeof self && self;
                ((_j = s_7 === null || s_7 === void 0 ? void 0 : s_7.yl) === null || _j === void 0 ? void 0 : _j.Cl) ? s_7.yl.Cl((function () { i_16(); }), { se: t }) : Promise.resolve().then((function () { return i_16(); }));
            };
            for (var _k = 0, i_15 = i; _k < i_15.length; _k++) {
                var n_7 = i_15[_k];
                _loop_1(n_7);
            }
        };
        Kt.prototype.xl = function (t) { if (this.va.has(t))
            return; if (0 === this.qt.Eh().length)
            return; var i = this.bl(t); this.va.set(t, i); };
        return Kt;
    }(bt));
    var Gt = [3], Zt = [0, 1, 2, 3];
    var Xt = /** @class */ (function () {
        function Xt(t) {
            this.yn = t;
        }
        Xt.prototype.Pl = function (t, i, n) {
            var _this = this;
            var s = t;
            if (0 === this.yn.mode)
                return s;
            var e = n.kn(), r = e.zt();
            if (null === r)
                return s;
            var h = e.Nt(t, r), a = n.kl().filter((function (t) { return t instanceof Kt; })).reduce((function (t, s) { if (n.Gs(s) || !s.It())
                return t; var e = s.Ft(), r = s.Un(); if (e.Zi() || !r.Le(i))
                return t; var h = r.gh(i); if (null === h)
                return t; var a = l(s.zt()), o = 3 === _this.yn.mode ? Zt : Gt; return t.concat(o.map((function (t) { return e.Nt(h.Wt[t], a.Wt); }))); }), []);
            if (0 === a.length)
                return s;
            a.sort((function (t, i) { return Math.abs(t - h) - Math.abs(i - h); }));
            var o = a[0];
            return s = e.Tn(o, r), s;
        };
        return Xt;
    }());
    function Jt(t, i, n) { return Math.min(Math.max(t, i), n); }
    function Qt(t, i, n) { return i - t <= n; }
    function ti(t) { var i = Math.ceil(t); return i % 2 == 0 ? i - 1 : i; }
    var ii = /** @class */ (function (_super) {
        __extends(ii, _super);
        function ii() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.qt = null;
            return _this;
        }
        ii.prototype.ht = function (t) { this.qt = t; };
        ii.prototype.et = function (_j) {
            var _this = this;
            var t = _j.context, i = _j.bitmapSize, n = _j.horizontalPixelRatio, e = _j.verticalPixelRatio;
            if (null === this.qt)
                return;
            var r = Math.max(1, Math.floor(n));
            t.lineWidth = r, function (t, i) { t.save(), t.lineWidth % 2 && t.translate(.5, .5), i(), t.restore(); }(t, (function () { var h = a(_this.qt); if (h.Tl) {
                t.strokeStyle = h.Rl, s(t, h.Dl), t.beginPath();
                for (var _j = 0, _k = h.Il; _j < _k.length; _j++) {
                    var s_8 = _k[_j];
                    var e_5 = Math.round(s_8.Vl * n);
                    t.moveTo(e_5, -r), t.lineTo(e_5, i.height + r);
                }
                t.stroke();
            } if (h.El) {
                t.strokeStyle = h.Bl, s(t, h.Al), t.beginPath();
                for (var _q = 0, _y = h.zl; _q < _y.length; _q++) {
                    var n_8 = _y[_q];
                    var s_9 = Math.round(n_8.Vl * e);
                    t.moveTo(-r, s_9), t.lineTo(i.width + r, s_9);
                }
                t.stroke();
            } }));
        };
        return ii;
    }(y));
    var ni = /** @class */ (function () {
        function ni(t) {
            this.Xt = new ii, this.xt = !0, this.yt = t;
        }
        ni.prototype.Pt = function () { this.xt = !0; };
        ni.prototype.Tt = function () { if (this.xt) {
            var t_23 = this.yt.Qt().N().grid, i_17 = { El: t_23.horzLines.visible, Tl: t_23.vertLines.visible, Bl: t_23.horzLines.color, Rl: t_23.vertLines.color, Al: t_23.horzLines.style, Dl: t_23.vertLines.style, zl: this.yt.kn().Ll(), Il: (this.yt.Qt().Bt().Ll() || []).map((function (t) { return ({ Vl: t.coord }); })) };
            this.Xt.ht(i_17), this.xt = !1;
        } return this.Xt; };
        return ni;
    }());
    var si = /** @class */ (function () {
        function si(t) {
            this.Yh = new ni(t);
        }
        si.prototype.wr = function () { return this.Yh; };
        return si;
    }());
    var ei = { Ol: 4, Nl: 1e-4 };
    function ri(t, i) { var n = 100 * (t - i) / i; return i < 0 ? -n : n; }
    function hi(t, i) { var n = ri(t.Je(), i), s = ri(t.Qe(), i); return new dt(n, s); }
    function ai(t, i) { var n = 100 * (t - i) / i + 100; return i < 0 ? -n : n; }
    function li(t, i) { var n = ai(t.Je(), i), s = ai(t.Qe(), i); return new dt(n, s); }
    function oi(t, i) { var n = Math.abs(t); if (n < 1e-15)
        return 0; var s = Math.log10(n + i.Nl) + i.Ol; return t < 0 ? -s : s; }
    function _i(t, i) { var n = Math.abs(t); if (n < 1e-15)
        return 0; var s = Math.pow(10, n - i.Ol) - i.Nl; return t < 0 ? -s : s; }
    function ui(t, i) { if (null === t)
        return null; var n = oi(t.Je(), i), s = oi(t.Qe(), i); return new dt(n, s); }
    function ci(t, i) { if (null === t)
        return null; var n = _i(t.Je(), i), s = _i(t.Qe(), i); return new dt(n, s); }
    function di(t) { if (null === t)
        return ei; var i = Math.abs(t.Qe() - t.Je()); if (i >= 1 || i < 1e-15)
        return ei; var n = Math.ceil(Math.abs(Math.log10(i))), s = ei.Ol + n; return { Ol: s, Nl: 1 / Math.pow(10, s) }; }
    var fi = /** @class */ (function () {
        function fi(t, i) {
            if (this.Fl = t, this.Wl = i, function (t) { if (t < 0)
                return !1; if (t > 1e18)
                return !0; for (var i_18 = t; i_18 > 1; i_18 /= 10)
                if (i_18 % 10 != 0)
                    return !1; return !0; }(this.Fl))
                this.Hl = [2, 2.5, 2];
            else {
                this.Hl = [];
                for (var t_24 = this.Fl; 1 !== t_24;) {
                    if (t_24 % 2 == 0)
                        this.Hl.push(2), t_24 /= 2;
                    else {
                        if (t_24 % 5 != 0)
                            throw new Error("unexpected base");
                        this.Hl.push(2, 2.5), t_24 /= 5;
                    }
                    if (this.Hl.length > 100)
                        throw new Error("something wrong with base");
                }
            }
        }
        fi.prototype.Ul = function (t, i, n) { var s = 0 === this.Fl ? 0 : 1 / this.Fl; var e = Math.pow(10, Math.max(0, Math.ceil(Math.log10(t - i)))), r = 0, h = this.Wl[0]; for (;;) {
            var t_25 = Qt(e, s, 1e-14) && e > s + 1e-14, i_19 = Qt(e, n * h, 1e-14), a_4 = Qt(e, 1, 1e-14);
            if (!(t_25 && i_19 && a_4))
                break;
            e /= h, h = this.Wl[++r % this.Wl.length];
        } if (e <= s + 1e-14 && (e = s), e = Math.max(1, e), this.Hl.length > 0 && (a = e, l = 1, o = 1e-14, Math.abs(a - l) < o))
            for (r = 0, h = this.Hl[0]; Qt(e, n * h, 1e-14) && e > s + 1e-14;)
                e /= h, h = this.Hl[++r % this.Hl.length]; var a, l, o; return e; };
        return fi;
    }());
    var pi = /** @class */ (function () {
        function pi(t, i, n, s) {
            this.$l = [], this.Ki = t, this.Fl = i, this.jl = n, this.ql = s;
        }
        pi.prototype.Ul = function (t, i) { if (t < i)
            throw new Error("high < low"); var n = this.Ki.$t(), s = (t - i) * this.Yl() / n, e = new fi(this.Fl, [2, 2.5, 2]), r = new fi(this.Fl, [2, 2, 2.5]), h = new fi(this.Fl, [2.5, 2, 2]), a = []; return a.push(e.Ul(t, i, s), r.Ul(t, i, s), h.Ul(t, i, s)), function (t) { if (t.length < 1)
            throw Error("array is empty"); var i = t[0]; for (var n_9 = 1; n_9 < t.length; ++n_9)
            t[n_9] < i && (i = t[n_9]); return i; }(a); };
        pi.prototype.Kl = function () { var t = this.Ki, i = t.zt(); if (null === i)
            return void (this.$l = []); var n = t.$t(), s = this.jl(n - 1, i), e = this.jl(0, i), r = this.Ki.N().entireTextOnly ? this.Gl() / 2 : 0, h = r, a = n - 1 - r, l = Math.max(s, e), o = Math.min(s, e); if (l === o)
            return void (this.$l = []); var _ = this.Ul(l, o); if (this.Zl(i, _, l, o, h, a), t.Xl() && this.Jl(_, o, l)) {
            var t_26 = this.Ki.Ql();
            this.io(i, _, h, a, t_26, 2 * t_26);
        } var u = this.$l.map((function (t) { return t.no; })), c = this.Ki.so(u); for (var t_27 = 0; t_27 < this.$l.length; t_27++)
            this.$l[t_27].eo = c[t_27]; };
        pi.prototype.Ll = function () { return this.$l; };
        pi.prototype.Gl = function () { return this.Ki.P(); };
        pi.prototype.Yl = function () { return Math.ceil(this.Gl() * this.Ki.N().tickMarkDensity); };
        pi.prototype.Zl = function (t, i, n, s, e, r) { var h = this.$l, a = this.Ki; var l = n % i; l += l < 0 ? i : 0; var o = n >= s ? 1 : -1; var _ = null, u = 0; for (var c_1 = n - l; c_1 > s; c_1 -= i) {
            var n_10 = this.ql(c_1, t, !0);
            null !== _ && Math.abs(n_10 - _) < this.Yl() || (n_10 < e || n_10 > r || (u < h.length ? (h[u].Vl = n_10, h[u].eo = a.ro(c_1), h[u].no = c_1) : h.push({ Vl: n_10, eo: a.ro(c_1), no: c_1 }), u++, _ = n_10, a.ho() && (i = this.Ul(c_1 * o, s))));
        } h.length = u; };
        pi.prototype.io = function (t, i, n, s, e, r) { var h = this.$l, a = this.ao(t, n, e, r), l = this.ao(t, s, -r, -e), o = this.ql(0, t, !0) - this.ql(i, t, !0); h.length > 0 && h[0].Vl - a.Vl < o / 2 && h.shift(), h.length > 0 && l.Vl - h[h.length - 1].Vl < o / 2 && h.pop(), h.unshift(a), h.push(l); };
        pi.prototype.ao = function (t, i, n, s) { var e = (n + s) / 2, r = this.jl(i + n, t), h = this.jl(i + s, t), a = Math.min(r, h), l = Math.max(r, h), o = Math.max(.1, this.Ul(l, a)), _ = this.jl(i + e, t), u = _ - _ % o, c = this.ql(u, t, !0); return { eo: this.Ki.ro(u), Vl: c, no: u }; };
        pi.prototype.Jl = function (t, i, n) { var s = l(this.Ki.ar()); return this.Ki.ho() && (s = ci(s, this.Ki.lo())), s.Je() - i < t && n - s.Qe() < t; };
        return pi;
    }());
    function vi(t) { return t.slice().sort((function (t, i) { return a(t.ln()) - a(i.ln()); })); }
    var mi;
    !function (t) { t[t.Normal = 0] = "Normal", t[t.Logarithmic = 1] = "Logarithmic", t[t.Percentage = 2] = "Percentage", t[t.IndexedTo100 = 3] = "IndexedTo100"; }(mi || (mi = {}));
    var wi = new J, gi = new X(100, 1);
    var Mi = /** @class */ (function () {
        function Mi(t, i, n, s, e) {
            this.oo = 0, this._o = null, this.rr = null, this.uo = null, this.co = { do: !1, fo: null }, this.po = !1, this.vo = 0, this.mo = 0, this.wo = new o, this.Mo = new o, this.bo = [], this.So = null, this.xo = null, this.Co = null, this.yo = null, this.Po = null, this.el = gi, this.ko = di(null), this.To = t, this.yn = i, this.Ro = n, this.Do = s, this.Io = e, this.Vo = new pi(this, 100, this.Eo.bind(this), this.Bo.bind(this));
        }
        Mi.prototype.pl = function () { return this.To; };
        Mi.prototype.N = function () { return this.yn; };
        Mi.prototype.vr = function (t) { if (_(this.yn, t), this.vl(), void 0 !== t.mode && this.Ao({ _e: t.mode }), void 0 !== t.scaleMargins) {
            var i_20 = h(t.scaleMargins.top), n_11 = h(t.scaleMargins.bottom);
            if (i_20 < 0 || i_20 > 1)
                throw new Error("Invalid top margin - expect value between 0 and 1, given=".concat(i_20));
            if (n_11 < 0 || n_11 > 1)
                throw new Error("Invalid bottom margin - expect value between 0 and 1, given=".concat(n_11));
            if (i_20 + n_11 > 1)
                throw new Error("Invalid margins - sum of margins must be less than 1, given=".concat(i_20 + n_11));
            this.zo(), this.Co = null;
        } };
        Mi.prototype.Lo = function () { return this.yn.autoScale; };
        Mi.prototype.Oo = function () { return this.po; };
        Mi.prototype.ho = function () { return 1 === this.yn.mode; };
        Mi.prototype.je = function () { return 2 === this.yn.mode; };
        Mi.prototype.No = function () { return 3 === this.yn.mode; };
        Mi.prototype.lo = function () { return this.ko; };
        Mi.prototype._e = function () { return { hs: this.yn.autoScale, Fo: this.yn.invertScale, _e: this.yn.mode }; };
        Mi.prototype.Ao = function (t) { var i = this._e(); var n = null; void 0 !== t.hs && (this.yn.autoScale = t.hs), void 0 !== t._e && (this.yn.mode = t._e, 2 !== t._e && 3 !== t._e || (this.yn.autoScale = !0), this.co.do = !1), 1 === i._e && t._e !== i._e && (!function (t, i) { if (null === t)
            return !1; var n = _i(t.Je(), i), s = _i(t.Qe(), i); return isFinite(n) && isFinite(s); }(this.rr, this.ko) ? this.yn.autoScale = !0 : (n = ci(this.rr, this.ko), null !== n && this.Wo(n))), 1 === t._e && t._e !== i._e && (n = ui(this.rr, this.ko), null !== n && this.Wo(n)); var s = i._e !== this.yn.mode; s && (2 === i._e || this.je()) && this.vl(), s && (3 === i._e || this.No()) && this.vl(), void 0 !== t.Fo && i.Fo !== t.Fo && (this.yn.invertScale = t.Fo, this.Ho()), this.Mo.p(i, this._e()); };
        Mi.prototype.Uo = function () { return this.Mo; };
        Mi.prototype.P = function () { return this.Ro.fontSize; };
        Mi.prototype.$t = function () { return this.oo; };
        Mi.prototype.$o = function (t) { this.oo !== t && (this.oo = t, this.zo(), this.Co = null); };
        Mi.prototype.jo = function () { if (this._o)
            return this._o; var t = this.$t() - this.qo() - this.Yo(); return this._o = t, t; };
        Mi.prototype.ar = function () { return this.Ko(), this.rr; };
        Mi.prototype.Wo = function (t, i) { var n = this.rr; (i || null === n && null !== t || null !== n && !n.Ze(t)) && (this.Co = null, this.rr = t); };
        Mi.prototype.Go = function (t) { this.Wo(t), this.Zo(null !== t); };
        Mi.prototype.Zi = function () { return this.Ko(), 0 === this.oo || !this.rr || this.rr.Zi(); };
        Mi.prototype.Xo = function (t) { return this.Fo() ? t : this.$t() - 1 - t; };
        Mi.prototype.Nt = function (t, i) { return this.je() ? t = ri(t, i) : this.No() && (t = ai(t, i)), this.Bo(t, i); };
        Mi.prototype.Jo = function (t, i, n) { this.Ko(); var s = this.Yo(), e = a(this.ar()), r = e.Je(), h = e.Qe(), l = this.jo() - 1, o = this.Fo(), _ = l / (h - r), u = void 0 === n ? 0 : n.from, c = void 0 === n ? t.length : n.to, d = this.Qo(); for (var n_12 = u; n_12 < c; n_12++) {
            var e_6 = t[n_12], h_2 = e_6.gt;
            if (isNaN(h_2))
                continue;
            var a_5 = h_2;
            null !== d && (a_5 = d(e_6.gt, i));
            var l_4 = s + _ * (a_5 - r), u_2 = o ? l_4 : this.oo - 1 - l_4;
            e_6.ut = u_2;
        } };
        Mi.prototype.t_ = function (t, i, n) { this.Ko(); var s = this.Yo(), e = a(this.ar()), r = e.Je(), h = e.Qe(), l = this.jo() - 1, o = this.Fo(), _ = l / (h - r), u = void 0 === n ? 0 : n.from, c = void 0 === n ? t.length : n.to, d = this.Qo(); for (var n_13 = u; n_13 < c; n_13++) {
            var e_7 = t[n_13];
            var h_3 = e_7.jr, a_6 = e_7.qr, l_5 = e_7.Yr, u_3 = e_7.Kr;
            null !== d && (h_3 = d(e_7.jr, i), a_6 = d(e_7.qr, i), l_5 = d(e_7.Yr, i), u_3 = d(e_7.Kr, i));
            var c_2 = s + _ * (h_3 - r), f_1 = o ? c_2 : this.oo - 1 - c_2;
            e_7.i_ = f_1, c_2 = s + _ * (a_6 - r), f_1 = o ? c_2 : this.oo - 1 - c_2, e_7.n_ = f_1, c_2 = s + _ * (l_5 - r), f_1 = o ? c_2 : this.oo - 1 - c_2, e_7.s_ = f_1, c_2 = s + _ * (u_3 - r), f_1 = o ? c_2 : this.oo - 1 - c_2, e_7.e_ = f_1;
        } };
        Mi.prototype.Tn = function (t, i) { var n = this.Eo(t, i); return this.r_(n, i); };
        Mi.prototype.r_ = function (t, i) { var n = t; return this.je() ? n = function (t, i) { return i < 0 && (t = -t), t / 100 * i + i; }(n, i) : this.No() && (n = function (t, i) { return t -= 100, i < 0 && (t = -t), t / 100 * i + i; }(n, i)), n; };
        Mi.prototype.kl = function () { return this.bo; };
        Mi.prototype.Dt = function () { return this.xo || (this.xo = vi(this.bo)), this.xo; };
        Mi.prototype.h_ = function (t) { -1 === this.bo.indexOf(t) && (this.bo.push(t), this.vl(), this.a_()); };
        Mi.prototype.l_ = function (t) { var i = this.bo.indexOf(t); if (-1 === i)
            throw new Error("source is not attached to scale"); this.bo.splice(i, 1), 0 === this.bo.length && (this.Ao({ hs: !0 }), this.Wo(null)), this.vl(), this.a_(); };
        Mi.prototype.zt = function () { var t = null; for (var _j = 0, _k = this.bo; _j < _k.length; _j++) {
            var i_21 = _k[_j];
            var n_14 = i_21.zt();
            null !== n_14 && ((null === t || n_14.Oa < t.Oa) && (t = n_14));
        } return null === t ? null : t.Wt; };
        Mi.prototype.Fo = function () { return this.yn.invertScale; };
        Mi.prototype.Ll = function () { var t = null === this.zt(); if (null !== this.Co && (t || this.Co.o_ === t))
            return this.Co.Ll; this.Vo.Kl(); var i = this.Vo.Ll(); return this.Co = { Ll: i, o_: t }, this.wo.p(), i; };
        Mi.prototype.__ = function () { return this.wo; };
        Mi.prototype.u_ = function (t) { this.je() || this.No() || null === this.yo && null === this.uo && (this.Zi() || (this.yo = this.oo - t, this.uo = a(this.ar()).Xe())); };
        Mi.prototype.c_ = function (t) { if (this.je() || this.No())
            return; if (null === this.yo)
            return; this.Ao({ hs: !1 }), (t = this.oo - t) < 0 && (t = 0); var i = (this.yo + .2 * (this.oo - 1)) / (t + .2 * (this.oo - 1)); var n = a(this.uo).Xe(); i = Math.max(i, .1), n.ir(i), this.Wo(n); };
        Mi.prototype.d_ = function () { this.je() || this.No() || (this.yo = null, this.uo = null); };
        Mi.prototype.f_ = function (t) { this.Lo() || null === this.Po && null === this.uo && (this.Zi() || (this.Po = t, this.uo = a(this.ar()).Xe())); };
        Mi.prototype.p_ = function (t) { if (this.Lo())
            return; if (null === this.Po)
            return; var i = a(this.ar()).tr() / (this.jo() - 1); var n = t - this.Po; this.Fo() && (n *= -1); var s = n * i, e = a(this.uo).Xe(); e.nr(s), this.Wo(e, !0), this.Co = null; };
        Mi.prototype.v_ = function () { this.Lo() || null !== this.Po && (this.Po = null, this.uo = null); };
        Mi.prototype.sl = function () { return this.el || this.vl(), this.el; };
        Mi.prototype.Ji = function (t, i) { switch (this.yn.mode) {
            case 2: return this.m_(ri(t, i));
            case 3: return this.sl().format(ai(t, i));
            default: return this.cr(t);
        } };
        Mi.prototype.ro = function (t) { switch (this.yn.mode) {
            case 2: return this.m_(t);
            case 3: return this.sl().format(t);
            default: return this.cr(t);
        } };
        Mi.prototype.so = function (t) { switch (this.yn.mode) {
            case 2: return this.w_(t);
            case 3: return this.sl().formatTickmarks(t);
            default: return this.g_(t);
        } };
        Mi.prototype.xa = function (t) { return this.cr(t, a(this.So).sl()); };
        Mi.prototype.Ca = function (t, i) { return t = ri(t, i), this.m_(t, wi); };
        Mi.prototype.M_ = function () { return this.bo; };
        Mi.prototype.b_ = function (t) { this.co = { fo: t, do: !1 }; };
        Mi.prototype.Nn = function () { this.bo.forEach((function (t) { return t.Nn(); })); };
        Mi.prototype.Xl = function () { return this.yn.ensureEdgeTickMarksVisible && this.Lo(); };
        Mi.prototype.Ql = function () { return this.P() / 2; };
        Mi.prototype.vl = function () { this.Co = null; var t = 1 / 0; this.So = null; for (var _j = 0, _k = this.bo; _j < _k.length; _j++) {
            var i_22 = _k[_j];
            i_22.ln() < t && (t = i_22.ln(), this.So = i_22);
        } var i = 100; null !== this.So && (i = Math.round(this.So.Kh())), this.el = gi, this.je() ? (this.el = wi, i = 100) : this.No() ? (this.el = new X(100, 1), i = 100) : null !== this.So && (this.el = this.So.sl()), this.Vo = new pi(this, i, this.Eo.bind(this), this.Bo.bind(this)), this.Vo.Kl(); };
        Mi.prototype.a_ = function () { this.xo = null; };
        Mi.prototype.S_ = function () { return null === this.So || this.je() || this.No() ? 1 : 1 / this.So.Kh(); };
        Mi.prototype.Xi = function () { return this.Io; };
        Mi.prototype.Zo = function (t) { this.po = t; };
        Mi.prototype.qo = function () { return this.Fo() ? this.yn.scaleMargins.bottom * this.$t() + this.mo : this.yn.scaleMargins.top * this.$t() + this.vo; };
        Mi.prototype.Yo = function () { return this.Fo() ? this.yn.scaleMargins.top * this.$t() + this.vo : this.yn.scaleMargins.bottom * this.$t() + this.mo; };
        Mi.prototype.Ko = function () { this.co.do || (this.co.do = !0, this.x_()); };
        Mi.prototype.zo = function () { this._o = null; };
        Mi.prototype.Bo = function (t, i) { if (this.Ko(), this.Zi())
            return 0; t = this.ho() && t ? oi(t, this.ko) : t; var n = a(this.ar()), s = this.Yo() + (this.jo() - 1) * (t - n.Je()) / n.tr(); return this.Xo(s); };
        Mi.prototype.Eo = function (t, i) { if (this.Ko(), this.Zi())
            return 0; var n = this.Xo(t), s = a(this.ar()), e = s.Je() + s.tr() * ((n - this.Yo()) / (this.jo() - 1)); return this.ho() ? _i(e, this.ko) : e; };
        Mi.prototype.Ho = function () { this.Co = null, this.Vo.Kl(); };
        Mi.prototype.x_ = function () { if (this.Oo() && !this.Lo())
            return; var t = this.co.fo; if (null === t)
            return; var i = null; var n = this.M_(); var s = 0, e = 0; for (var _j = 0, n_15 = n; _j < n_15.length; _j++) {
            var r_5 = n_15[_j];
            if (!r_5.It())
                continue;
            var n_16 = r_5.zt();
            if (null === n_16)
                continue;
            var h_4 = r_5.la(t.Na(), t.bi());
            var l_6 = h_4 && h_4.ar();
            if (null !== l_6) {
                switch (this.yn.mode) {
                    case 1:
                        l_6 = ui(l_6, this.ko);
                        break;
                    case 2:
                        l_6 = hi(l_6, n_16.Wt);
                        break;
                    case 3: l_6 = li(l_6, n_16.Wt);
                }
                if (i = null === i ? l_6 : i.Ss(a(l_6)), null !== h_4) {
                    var t_28 = h_4.lr();
                    null !== t_28 && (s = Math.max(s, t_28.above), e = Math.max(e, t_28.below));
                }
            }
        } if (this.Xl() && (s = Math.max(s, this.Ql()), e = Math.max(e, this.Ql())), s === this.vo && e === this.mo || (this.vo = s, this.mo = e, this.Co = null, this.zo()), null !== i) {
            if (i.Je() === i.Qe()) {
                var t_29 = 5 * this.S_();
                this.ho() && (i = ci(i, this.ko)), i = new dt(i.Je() - t_29, i.Qe() + t_29), this.ho() && (i = ui(i, this.ko));
            }
            if (this.ho()) {
                var t_30 = ci(i, this.ko), n_17 = di(t_30);
                if (r = n_17, h = this.ko, r.Ol !== h.Ol || r.Nl !== h.Nl) {
                    var s_10 = null !== this.uo ? ci(this.uo, this.ko) : null;
                    this.ko = n_17, i = ui(t_30, n_17), null !== s_10 && (this.uo = ui(s_10, n_17));
                }
            }
            this.Wo(i);
        }
        else
            null === this.rr && (this.Wo(new dt(-.5, .5)), this.ko = di(null)); var r, h; };
        Mi.prototype.Qo = function () {
            var _this = this;
            return this.je() ? ri : this.No() ? ai : this.ho() ? function (t) { return oi(t, _this.ko); } : null;
        };
        Mi.prototype.C_ = function (t, i, n) { return void 0 === i ? (void 0 === n && (n = this.sl()), n.format(t)) : i(t); };
        Mi.prototype.y_ = function (t, i, n) { return void 0 === i ? (void 0 === n && (n = this.sl()), n.formatTickmarks(t)) : i(t); };
        Mi.prototype.cr = function (t, i) { return this.C_(t, this.Do.priceFormatter, i); };
        Mi.prototype.g_ = function (t, i) { var _j; var n = this.Do.priceFormatter; return this.y_(t, (_j = this.Do.tickmarksPriceFormatter) !== null && _j !== void 0 ? _j : (n ? function (t) { return t.map(n); } : void 0), i); };
        Mi.prototype.m_ = function (t, i) { return this.C_(t, this.Do.percentageFormatter, i); };
        Mi.prototype.w_ = function (t, i) { var _j; var n = this.Do.percentageFormatter; return this.y_(t, (_j = this.Do.tickmarksPercentageFormatter) !== null && _j !== void 0 ? _j : (n ? function (t) { return t.map(n); } : void 0), i); };
        return Mi;
    }());
    function bi(t) { return t instanceof Kt; }
    var Si = /** @class */ (function () {
        function Si(t, i) {
            this.bo = [], this.P_ = new Map, this.oo = 0, this.k_ = 0, this.T_ = 1, this.xo = null, this.R_ = null, this.D_ = !1, this.I_ = new o, this.fa = [], this.ia = t, this.sn = i, this.V_ = new si(this);
            var n = i.N();
            this.E_ = this.B_("left", n.leftPriceScale), this.A_ = this.B_("right", n.rightPriceScale), this.E_.Uo().i(this.z_.bind(this, this.E_), this), this.A_.Uo().i(this.z_.bind(this, this.A_), this), this.L_(n);
        }
        Si.prototype.L_ = function (t) { if (t.leftPriceScale && this.E_.vr(t.leftPriceScale), t.rightPriceScale && this.A_.vr(t.rightPriceScale), t.localization && (this.E_.vl(), this.A_.vl()), t.overlayPriceScales) {
            var i_24 = Array.from(this.P_.values());
            for (var _j = 0, i_23 = i_24; _j < i_23.length; _j++) {
                var n_18 = i_23[_j];
                var i_25 = a(n_18[0].Ft());
                i_25.vr(t.overlayPriceScales), t.localization && i_25.vl();
            }
        } };
        Si.prototype.O_ = function (t) { switch (t) {
            case "left": return this.E_;
            case "right": return this.A_;
        } return this.P_.has(t) ? h(this.P_.get(t))[0].Ft() : null; };
        Si.prototype.m = function () { this.Qt().N_().u(this), this.E_.Uo().u(this), this.A_.Uo().u(this), this.bo.forEach((function (t) { t.m && t.m(); })), this.fa = this.fa.filter((function (t) { var i = t.Qh(); return i.detached && i.detached(), !1; })), this.I_.p(); };
        Si.prototype.F_ = function () { return this.T_; };
        Si.prototype.W_ = function (t) { this.T_ = t; };
        Si.prototype.Qt = function () { return this.sn; };
        Si.prototype.nn = function () { return this.k_; };
        Si.prototype.$t = function () { return this.oo; };
        Si.prototype.H_ = function (t) { this.k_ = t, this.U_(); };
        Si.prototype.$o = function (t) {
            var _this = this;
            this.oo = t, this.E_.$o(t), this.A_.$o(t), this.bo.forEach((function (i) { if (_this.Gs(i)) {
                var n_19 = i.Ft();
                null !== n_19 && n_19.$o(t);
            } })), this.U_();
        };
        Si.prototype.j_ = function (t) { this.D_ = t; };
        Si.prototype.q_ = function () { return this.D_; };
        Si.prototype.Y_ = function () { return this.bo.filter(bi); };
        Si.prototype.kl = function () { return this.bo; };
        Si.prototype.Gs = function (t) { var i = t.Ft(); return null === i || this.E_ !== i && this.A_ !== i; };
        Si.prototype.h_ = function (t, i, n) { this.K_(t, i, n ? t.ln() : this.bo.length); };
        Si.prototype.l_ = function (t, i) { var n = this.bo.indexOf(t); r(-1 !== n, "removeDataSource: invalid data source"), this.bo.splice(n, 1), i || this.bo.forEach((function (t, i) { return t._n(i); })); var s = a(t.Ft()).pl(); if (this.P_.has(s)) {
            var i_26 = h(this.P_.get(s)), n_20 = i_26.indexOf(t);
            -1 !== n_20 && (i_26.splice(n_20, 1), 0 === i_26.length && this.P_.delete(s));
        } var e = t.Ft(); e && e.kl().indexOf(t) >= 0 && (e.l_(t), this.G_(e)), this.Z_(); };
        Si.prototype.Xs = function (t) { return t === this.E_ ? "left" : t === this.A_ ? "right" : "overlay"; };
        Si.prototype.X_ = function () { return this.E_; };
        Si.prototype.J_ = function () { return this.A_; };
        Si.prototype.Q_ = function (t, i) { t.u_(i); };
        Si.prototype.tu = function (t, i) { t.c_(i), this.U_(); };
        Si.prototype.iu = function (t) { t.d_(); };
        Si.prototype.nu = function (t, i) { t.f_(i); };
        Si.prototype.su = function (t, i) { t.p_(i), this.U_(); };
        Si.prototype.eu = function (t) { t.v_(); };
        Si.prototype.U_ = function () { this.bo.forEach((function (t) { t.Nn(); })); };
        Si.prototype.kn = function () { var _j; var _k = this.ru(), t = _k[0], i = _k[1]; var n = null; return t.N().visible && 0 !== t.kl().length ? n = t : i.N().visible && 0 !== i.kl().length ? n = i : 0 !== this.bo.length && (n = this.bo[0].Ft()), null === n && (n = (_j = this.Zs()) !== null && _j !== void 0 ? _j : t), n; };
        Si.prototype.Zs = function () { var _j = this.ru(), t = _j[0], i = _j[1]; return t.N().visible ? t : i.N().visible ? i : null; };
        Si.prototype.G_ = function (t) { null !== t && t.Lo() && this.hu(t); };
        Si.prototype.au = function (t) { var i = this.ia.Be(); t.Ao({ hs: !0 }), null !== i && t.b_(i), this.U_(); };
        Si.prototype.lu = function () { this.hu(this.E_), this.hu(this.A_); };
        Si.prototype.ou = function () {
            var _this = this;
            this.G_(this.E_), this.G_(this.A_), this.bo.forEach((function (t) { _this.Gs(t) && _this.G_(t.Ft()); })), this.U_(), this.sn.mr();
        };
        Si.prototype.Dt = function () { return null === this.xo && (this.xo = vi(this.bo)), this.xo; };
        Si.prototype._u = function () { var _j; var t = this.Dt(), i = (_j = this.sn.cu()) === null || _j === void 0 ? void 0 : _j.uu, n = this.sn.N().hoveredSeriesOnTop, s = this.R_; if (null !== s && s.Kh === t && s.du === i && s.fu === n)
            return s.pu; var e = function (t, i, n) { if (!n)
            return t; var s = t.indexOf(i); if (-1 === s || s === t.length - 1)
            return t; var e = []; for (var i_27 = 0; i_27 < t.length; i_27++)
            i_27 !== s && e.push(t[i_27]); return e.push(t[s]), e; }(t, i, n); return this.R_ = { Kh: t, du: i, fu: n, pu: e }, e; };
        Si.prototype.vu = function (t, i) { i = Jt(i, 0, this.bo.length - 1); var n = this.bo.indexOf(t); r(-1 !== n, "setSeriesOrder: invalid data source"), this.bo.splice(n, 1), this.bo.splice(i, 0, t), this.bo.forEach((function (t, i) { return t._n(i); })), this.Z_(); for (var _j = 0, _k = [this.E_, this.A_]; _j < _k.length; _j++) {
            var t_31 = _k[_j];
            t_31.a_(), t_31.vl();
        } this.sn.mr(); };
        Si.prototype.Vt = function () { return this.Dt().filter(bi); };
        Si.prototype.mu = function () { return this.I_; };
        Si.prototype.wu = function () { return this.V_; };
        Si.prototype.ol = function (t) { this.fa.push(new zt(t)); };
        Si.prototype._l = function (t) { this.fa = this.fa.filter((function (i) { return i.Qh() !== t; })), t.detached && t.detached(), this.sn.mr(); };
        Si.prototype.gu = function () { return this.fa; };
        Si.prototype.il = function (t, i) { return this.fa.map((function (n) { return n.Qs(t, i); })).filter((function (t) { return null !== t; })); };
        Si.prototype.hu = function (t) { var i = t.M_(); if (i && i.length > 0 && !this.ia.Zi()) {
            var i_28 = this.ia.Be();
            null !== i_28 && t.b_(i_28);
        } t.Nn(); };
        Si.prototype.K_ = function (t, i, n) { var s = this.O_(i); if (null === s && (s = this.B_(i, this.sn.N().overlayPriceScales)), this.bo.splice(n, 0, t), !q(i)) {
            var n_21 = this.P_.get(i) || [];
            n_21.push(t), this.P_.set(i, n_21);
        } t._n(n), s.h_(t), t.un(s), this.G_(s), this.Z_(); };
        Si.prototype.Z_ = function () { this.xo = null, this.R_ = null; };
        Si.prototype.ru = function () { return "left" === this.sn.N().defaultVisiblePriceScaleId ? [this.E_, this.A_] : [this.A_, this.E_]; };
        Si.prototype.z_ = function (t, i, n) { i._e !== n._e && this.hu(t); };
        Si.prototype.B_ = function (t, i) { var n = __assign({ visible: !0, autoScale: !0 }, p(i)), s = new Mi(t, n, this.sn.N().layout, this.sn.N().localization, this.sn.Xi()); return s.$o(this.$t()), s; };
        return Si;
    }());
    function xi(t, i) { return null === i || (2 === t.se && 2 !== i.se || (2 !== i.se || 2 === t.se) && (t.ne !== i.ne && t.ne < i.ne)); }
    function Ci(t) { return { te: t.te, ie: t.ie }; }
    function yi(t) { var _j, _k, _q; return { ne: (_j = t.distance) !== null && _j !== void 0 ? _j : 0, se: (_k = t.hitTestPriority) !== null && _k !== void 0 ? _k : ("marker" === t.itemType ? 2 : 0), ee: (_q = t.itemType) !== null && _q !== void 0 ? _q : "primitive", Mu: t.cursorStyle, te: t.externalId }; }
    function Pi(t) { var _j; return { uu: t.uu, bu: Ci(t.Su), Mu: t.Su.Mu, ee: (_j = t.Su.ee) !== null && _j !== void 0 ? _j : "primitive" }; }
    function ki(t, i, n, s) { var _j, _k; var e = null; for (var _q = 0, t_32 = t; _q < t_32.length; _q++) {
        var r_6 = t_32[_q];
        var t_33 = (_k = (_j = r_6.Qs) === null || _j === void 0 ? void 0 : _j.call(r_6, i, n, s)) !== null && _k !== void 0 ? _k : null;
        if (null === t_33) {
            var e_8 = r_6.Tt(s);
            t_33 = null !== e_8 && e_8.Qs ? e_8.Qs(i, n) : null;
        }
        if (null !== t_33) {
            var i_29 = { xu: r_6, Su: t_33 };
            (null === e || xi(i_29.Su, e.Su)) && (e = i_29);
        }
    } return e; }
    function Ti(t) { return void 0 !== t.jn; }
    function Ri(t, i, n) { var _j; var s = __spreadArray([t], t.Dt(), true).reverse(), e = function (t, i, n) { var _j, _k; var s, e, r; for (var _q = 0, t_34 = t; _q < t_34.length; _q++) {
        var l_7 = t_34[_q];
        var t_36 = (_k = (_j = l_7.il) === null || _j === void 0 ? void 0 : _j.call(l_7, i, n)) !== null && _k !== void 0 ? _k : [];
        for (var _y = 0, t_35 = t_36; _y < t_35.length; _y++) {
            var i_30 = t_35[_y];
            var t_37 = yi(i_30);
            h = i_30.zOrder, a = s === null || s === void 0 ? void 0 : s.zOrder, (!a || "top" === h && "top" !== a || "normal" === h && "bottom" === a || i_30.zOrder === (s === null || s === void 0 ? void 0 : s.zOrder) && void 0 !== e && xi(t_37, e) || i_30.zOrder === (s === null || s === void 0 ? void 0 : s.zOrder) && void 0 === e) && (s = i_30, e = t_37, r = l_7);
        }
    } var h, a; return s && r && e ? { Su: e, Cu: s, uu: r } : null; }(s, i, n); if ("top" === (e === null || e === void 0 ? void 0 : e.Cu.zOrder))
        return Pi(e); var r = null, h = null; for (var _k = 0, s_11 = s; _k < s_11.length; _k++) {
        var a_7 = s_11[_k];
        if (e && e.uu === a_7 && "bottom" !== e.Cu.zOrder && !e.Cu.isBackground)
            return r !== null && r !== void 0 ? r : Pi(e);
        if (Ti(a_7)) {
            var s_12 = ki(a_7.jn(t), i, n, t);
            if (null !== s_12) {
                var t_38 = { uu: a_7, xu: s_12.xu, bu: Ci(s_12.Su), Mu: s_12.Su.Mu, ee: (_j = s_12.Su.ee) !== null && _j !== void 0 ? _j : "primitive" };
                (null === r || xi(s_12.Su, h)) && (r = t_38, h = s_12.Su);
            }
        }
        if (e && e.uu === a_7 && "bottom" !== e.Cu.zOrder && e.Cu.isBackground)
            return r !== null && r !== void 0 ? r : Pi(e);
    } return null !== r ? r : (e === null || e === void 0 ? void 0 : e.Cu) ? Pi(e) : null; }
    var Di = /** @class */ (function () {
        function Di(t, i, n) {
            if (n === void 0) { n = 50; }
            this.Vs = 0, this.Es = 1, this.Bs = 1, this.zs = new Map, this.As = new Map, this.yu = t, this.Pu = i, this.Ls = n;
        }
        Di.prototype.ku = function (t) { var i = t.time, n = this.Pu.cacheKey(i), s = this.zs.get(n); if (void 0 !== s)
            return s.Tu; if (this.Vs === this.Ls) {
            var t_39 = this.As.get(this.Bs);
            this.As.delete(this.Bs), this.zs.delete(h(t_39)), this.Bs++, this.Vs--;
        } var e = this.yu(t); return this.zs.set(n, { Tu: e, Ws: this.Es }), this.As.set(this.Es, n), this.Vs++, this.Es++, e; };
        return Di;
    }());
    var Ii = /** @class */ (function () {
        function Ii(t, i) {
            r(t <= i, "right should be >= left"), this.Ru = t, this.Du = i;
        }
        Ii.prototype.Na = function () { return this.Ru; };
        Ii.prototype.bi = function () { return this.Du; };
        Ii.prototype.Iu = function () { return this.Du - this.Ru + 1; };
        Ii.prototype.Le = function (t) { return this.Ru <= t && t <= this.Du; };
        Ii.prototype.Ze = function (t) { return this.Ru === t.Na() && this.Du === t.bi(); };
        return Ii;
    }());
    function Vi(t, i) { return null === t || null === i ? t === i : t.Ze(i); }
    var Ei = /** @class */ (function () {
        function Ei() {
            this.Vu = new Map, this.zs = null, this.Eu = !1;
        }
        Ei.prototype.Bu = function (t) { this.Eu = t, this.zs = null; };
        Ei.prototype.Au = function (t, i) { this.zu(i), this.zs = null; for (var n_22 = i; n_22 < t.length; ++n_22) {
            var i_31 = t[n_22];
            var s_13 = this.Vu.get(i_31.timeWeight);
            void 0 === s_13 && (s_13 = [], this.Vu.set(i_31.timeWeight, s_13)), s_13.push({ index: n_22, time: i_31.time, weight: i_31.timeWeight, originalTime: i_31.originalTime });
        } };
        Ei.prototype.Lu = function (t, i, n, s, e) { var r = Math.ceil(i / t); return null !== this.zs && this.zs.Ou === r && e === this.zs.Nu && n === this.zs.Fu || (this.zs = { Nu: e, Fu: n, Ll: this.Wu(r, n, s), Ou: r }), this.zs.Ll; };
        Ei.prototype.zu = function (t) { if (0 === t)
            return void this.Vu.clear(); var i = []; this.Vu.forEach((function (n, s) { t <= n[0].index ? i.push(s) : n.splice(yt(n, t, (function (i) { return i.index < t; })), 1 / 0); })); for (var _j = 0, i_32 = i; _j < i_32.length; _j++) {
            var t_40 = i_32[_j];
            this.Vu.delete(t_40);
        } };
        Ei.prototype.Wu = function (t, i, n) { var s = []; var e = function (t) { return !i || n.has(t.index); }; for (var _j = 0, _k = Array.from(this.Vu.keys()).sort((function (t, i) { return i - t; })); _j < _k.length; _j++) {
            var i_33 = _k[_j];
            if (!this.Vu.get(i_33))
                continue;
            var n_23 = s;
            s = [];
            var r_7 = n_23.length;
            var a_8 = 0;
            var l_8 = h(this.Vu.get(i_33)), o_4 = l_8.length;
            var _4 = 1 / 0, u_4 = -1 / 0;
            for (var i_34 = 0; i_34 < o_4; i_34++) {
                var h_5 = l_8[i_34], o_5 = h_5.index;
                for (; a_8 < r_7;) {
                    var t_41 = n_23[a_8], i_35 = t_41.index;
                    if (!(i_35 < o_5 && e(t_41))) {
                        _4 = i_35;
                        break;
                    }
                    a_8++, s.push(t_41), u_4 = i_35, _4 = 1 / 0;
                }
                if (_4 - o_5 >= t && o_5 - u_4 >= t && e(h_5))
                    s.push(h_5), u_4 = o_5;
                else if (this.Eu)
                    return n_23;
            }
            for (; a_8 < r_7; a_8++)
                e(n_23[a_8]) && s.push(n_23[a_8]);
        } return s; };
        return Ei;
    }());
    var Bi = /** @class */ (function () {
        function Bi(t) {
            this.Hu = t;
        }
        Bi.prototype.Uu = function () { return null === this.Hu ? null : new Ii(Math.floor(this.Hu.Na()), Math.ceil(this.Hu.bi())); };
        Bi.prototype.$u = function () { return this.Hu; };
        Bi.ju = function () { return new Bi(null); };
        return Bi;
    }());
    function Ai(t, i) { return t.weight > i.weight ? t : i; }
    var zi = /** @class */ (function () {
        function zi(t, i, n, s) {
            this.k_ = 0, this.qu = null, this.Yu = [], this.Po = null, this.yo = null, this.Ku = new Ei, this.Gu = new Map, this.Zu = Bi.ju(), this.Xu = !0, this.Ju = new o, this.Qu = new o, this.tc = new o, this.nc = null, this.sc = null, this.ec = new Map, this.rc = -1, this.hc = [], this.ac = 1, this.yn = i, this.Do = n, this.lc = i.rightOffset, this.oc = i.barSpacing, this.sn = t, this._c(i), this.Pu = s, this.uc(), this.Ku.Bu(i.uniformDistribution), this.cc(), this.dc();
        }
        zi.prototype.N = function () { return this.yn; };
        zi.prototype.fc = function (t) { _(this.Do, t), this.vc(), this.uc(); };
        zi.prototype.vr = function (t, i) { var _j; _(this.yn, t), this.yn.fixLeftEdge && this.mc(), this.yn.fixRightEdge && this.wc(), void 0 !== t.barSpacing && this.sn.gs(t.barSpacing), void 0 !== t.rightOffset && this.sn.Ms(t.rightOffset), this._c(t), void 0 === t.minBarSpacing && void 0 === t.maxBarSpacing || this.sn.gs((_j = t.barSpacing) !== null && _j !== void 0 ? _j : this.oc), void 0 !== t.ignoreWhitespaceIndices && t.ignoreWhitespaceIndices !== this.yn.ignoreWhitespaceIndices && this.dc(), this.vc(), this.uc(), void 0 === t.enableConflation && void 0 === t.conflationThresholdFactor || this.cc(), this.tc.p(); };
        zi.prototype.Rn = function (t) { var _j, _k; return (_k = (_j = this.Yu[t]) === null || _j === void 0 ? void 0 : _j.time) !== null && _k !== void 0 ? _k : null; };
        zi.prototype.en = function (t) { var _j; return (_j = this.Yu[t]) !== null && _j !== void 0 ? _j : null; };
        zi.prototype.gc = function (t, i) {
            var _this = this;
            if (this.Yu.length < 1)
                return null;
            if (this.Pu.key(t) > this.Pu.key(this.Yu[this.Yu.length - 1].time))
                return i ? this.Yu.length - 1 : null;
            var n = yt(this.Yu, this.Pu.key(t), (function (t, i) { return _this.Pu.key(t.time) < i; }));
            return this.Pu.key(t) < this.Pu.key(this.Yu[n].time) ? i ? n : null : n;
        };
        zi.prototype.Zi = function () { return 0 === this.k_ || 0 === this.Yu.length || null === this.qu; };
        zi.prototype.Mc = function () { return this.Yu.length > 0; };
        zi.prototype.Be = function () { return this.bc(), this.Zu.Uu(); };
        zi.prototype.Sc = function () { return this.bc(), this.Zu.$u(); };
        zi.prototype.xc = function () { var t = this.Be(); if (null === t)
            return null; var i = { from: t.Na(), to: t.bi() }; return this.Cc(i); };
        zi.prototype.Cc = function (t) { var i = Math.round(t.from), n = Math.round(t.to), s = a(this.yc()), e = a(this.Pc()); return { from: a(this.en(Math.max(s, i))), to: a(this.en(Math.min(e, n))) }; };
        zi.prototype.kc = function (t) { return { from: a(this.gc(t.from, !0)), to: a(this.gc(t.to, !0)) }; };
        zi.prototype.nn = function () { return this.k_; };
        zi.prototype.H_ = function (t) { if (!isFinite(t) || t <= 0)
            return; if (this.k_ === t)
            return; var i = this.Sc(), n = this.k_; if (this.k_ = t, this.Xu = !0, this.yn.lockVisibleTimeRangeOnResize && 0 !== n) {
            var i_36 = this.oc * t / n;
            this.oc = i_36;
        } if (this.yn.fixLeftEdge && null !== i && i.Na() <= 0) {
            var i_37 = n - t;
            this.lc -= Math.round(i_37 / this.oc) + 1, this.Xu = !0;
        } this.Tc(), this.Rc(); };
        zi.prototype.jt = function (t) { if (this.Zi() || !c(t))
            return 0; var i = this.Dc() + this.lc - t; return this.k_ - (i + .5) * this.oc - 1; };
        zi.prototype.Ic = function (t, i) { var n = this.Dc(), s = void 0 === i ? 0 : i.from, e = void 0 === i ? t.length : i.to; for (var i_38 = s; i_38 < e; i_38++) {
            var s_14 = t[i_38].wt, e_9 = n + this.lc - s_14, r_8 = this.k_ - (e_9 + .5) * this.oc - 1;
            t[i_38]._t = r_8;
        } };
        zi.prototype.Vc = function (t, i) { var n = Math.ceil(this.Ec(t)); return i && this.yn.ignoreWhitespaceIndices && !this.Bc(n) ? this.Ac(n) : n; };
        zi.prototype.Ms = function (t) { this.Xu = !0, this.lc = t, this.Rc(), this.sn.zc(), this.sn.mr(); };
        zi.prototype.ml = function () { return this.oc; };
        zi.prototype.gs = function (t) { var i = this.oc; if (this.Lc(t), void 0 !== this.yn.rightOffsetPixels && 0 !== i) {
            var t_42 = this.lc * i / this.oc;
            this.lc = t_42;
        } this.Rc(), this.sn.zc(), this.sn.mr(); };
        zi.prototype.Oc = function () { return this.lc; };
        zi.prototype.Ll = function () { if (this.Zi())
            return null; if (null !== this.sc)
            return this.sc; var t = this.oc, i = 5 * (this.sn.N().layout.fontSize + 4) / 8 * (this.yn.tickMarkMaxCharacterLength || 8), n = Math.round(i / t), s = a(this.Be()), e = Math.max(s.Na(), s.Na() - n), r = Math.max(s.bi(), s.bi() - n), h = this.Ku.Lu(t, i, this.yn.ignoreWhitespaceIndices, this.ec, this.rc), l = this.yc() + n, o = this.Pc() - n, _ = this.Nc(), u = this.yn.fixLeftEdge || _, c = this.yn.fixRightEdge || _; var d = 0; for (var _j = 0, h_6 = h; _j < h_6.length; _j++) {
            var t_43 = h_6[_j];
            if (!(e <= t_43.index && t_43.index <= r))
                continue;
            var n_24 = void 0;
            d < this.hc.length ? (n_24 = this.hc[d], n_24.coord = this.jt(t_43.index), n_24.label = this.Fc(t_43), n_24.weight = t_43.weight) : (n_24 = { needAlignCoordinate: !1, coord: this.jt(t_43.index), label: this.Fc(t_43), weight: t_43.weight }, this.hc.push(n_24)), this.oc > i / 2 && !_ ? n_24.needAlignCoordinate = !1 : n_24.needAlignCoordinate = u && t_43.index <= l || c && t_43.index >= o, d++;
        } return this.hc.length = d, this.sc = this.hc, this.hc; };
        zi.prototype.Wc = function () { var t; this.Xu = !0, this.gs(this.yn.barSpacing), t = void 0 !== this.yn.rightOffsetPixels ? this.yn.rightOffsetPixels / this.ml() : this.yn.rightOffset, this.Ms(t); };
        zi.prototype.Hc = function (t) { this.Xu = !0, this.qu = t, this.Rc(), this.mc(); };
        zi.prototype.Uc = function (t, i) { var n = this.Ec(t), s = this.ml(), e = s + i * (s / 10); this.gs(e), this.yn.rightBarStaysOnScroll || this.Ms(this.Oc() + (n - this.Ec(t))); };
        zi.prototype.u_ = function (t) { this.Po && this.v_(), null === this.yo && null === this.nc && (this.Zi() || (this.yo = t, this.$c())); };
        zi.prototype.c_ = function (t) { if (null === this.nc)
            return; var i = Jt(this.k_ - t, 0, this.k_), n = Jt(this.k_ - a(this.yo), 0, this.k_); 0 !== i && 0 !== n && this.gs(this.nc.ml * i / n); };
        zi.prototype.d_ = function () { null !== this.yo && (this.yo = null, this.jc()); };
        zi.prototype.f_ = function (t) { null === this.Po && null === this.nc && (this.Zi() || (this.Po = t, this.$c())); };
        zi.prototype.p_ = function (t) { if (null === this.Po)
            return; var i = (this.Po - t) / this.ml(); this.lc = a(this.nc).Oc + i, this.Xu = !0, this.Rc(); };
        zi.prototype.v_ = function () { null !== this.Po && (this.Po = null, this.jc()); };
        zi.prototype.qc = function () { this.Yc(this.yn.rightOffset); };
        zi.prototype.Yc = function (t, i) {
            if (i === void 0) { i = 400; }
            if (!isFinite(t))
                throw new RangeError("offset is required and must be finite number");
            if (!isFinite(i) || i <= 0)
                throw new RangeError("animationDuration (optional) must be finite positive number");
            var n = this.lc, s = performance.now();
            this.sn.ps({ Kc: function (t) { return (t - s) / i >= 1; }, Gc: function (e) { var r = (e - s) / i; return r >= 1 ? t : n + (t - n) * r; } });
        };
        zi.prototype.Pt = function (t, i) { this.Xu = !0, this.Yu = t, this.Ku.Au(t, i), this.Rc(); };
        zi.prototype.Zc = function () { return this.Ju; };
        zi.prototype.Xc = function () { return this.Qu; };
        zi.prototype.Jc = function () { return this.tc; };
        zi.prototype.Dc = function () { return this.qu || 0; };
        zi.prototype.Qc = function (t, i) { var n = t.Iu(), s = i && this.yn.rightOffsetPixels || 0; this.Lc((this.k_ - s) / n), this.lc = t.bi() - this.Dc(), i && (this.lc = s ? s / this.ml() : this.yn.rightOffset), this.Rc(), this.Xu = !0, this.sn.zc(), this.sn.mr(); };
        zi.prototype.td = function () { var t = this.yc(), i = this.Pc(); if (null === t || null === i)
            return; var n = !this.yn.rightOffsetPixels && this.yn.rightOffset || 0; this.Qc(new Ii(t, i + n), !0); };
        zi.prototype.nd = function (t) { var i = new Ii(t.from, t.to); this.Qc(i); };
        zi.prototype.rn = function (t) { return void 0 !== this.Do.timeFormatter ? this.Do.timeFormatter(t.originalTime) : this.Pu.formatHorzItem(t.time); };
        zi.prototype.dc = function () { if (!this.yn.ignoreWhitespaceIndices)
            return; this.ec.clear(); var t = this.sn.Jn(); for (var _j = 0, t_44 = t; _j < t_44.length; _j++) {
            var i_39 = t_44[_j];
            for (var _k = 0, _q = i_39.fl(); _k < _q.length; _k++) {
                var t_45 = _q[_k];
                this.ec.set(t_45, !0);
            }
        } this.rc++; };
        zi.prototype.sd = function () { return this.ac; };
        zi.prototype.Sl = function () { var t = 1 / (window.devicePixelRatio || 1), i = this.yn.minBarSpacing; if (i >= t)
            return [1]; var n = [1]; var s = 2; for (; s <= 512;) {
            i < t / s && n.push(s), s *= 2;
        } return n; };
        zi.prototype.Nc = function () { var t = this.sn.N().handleScroll, i = this.sn.N().handleScale; return !(t.horzTouchDrag || t.mouseWheel || t.pressedMouseMove || t.vertTouchDrag || i.axisDoubleClickReset.time || i.axisPressedMouseMove.time || i.mouseWheel || i.pinch); };
        zi.prototype.yc = function () { return 0 === this.Yu.length ? null : 0; };
        zi.prototype.Pc = function () { return 0 === this.Yu.length ? null : this.Yu.length - 1; };
        zi.prototype.ed = function (t) { return (this.k_ - 1 - t) / this.oc; };
        zi.prototype.Ec = function (t) { var i = this.ed(t), n = this.Dc() + this.lc - i; return Math.round(1e6 * n) / 1e6; };
        zi.prototype.Lc = function (t) { var i = this.oc; this.oc = t, this.Tc(), i !== this.oc && (this.Xu = !0, this.rd(), this.cc()); };
        zi.prototype.bc = function () { if (!this.Xu)
            return; if (this.Xu = !1, this.Zi())
            return void this.hd(Bi.ju()); var t = this.Dc(), i = this.k_ / this.oc, n = this.lc + t, s = new Ii(n - i + 1, n); this.hd(new Bi(s)); };
        zi.prototype.Tc = function () { var t = Jt(this.oc, this.ad(), this.ld()); this.oc !== t && (this.oc = t, this.Xu = !0); };
        zi.prototype.ld = function () { return this.yn.maxBarSpacing > 0 ? this.yn.maxBarSpacing : .5 * this.k_; };
        zi.prototype.ad = function () { return this.yn.fixLeftEdge && this.yn.fixRightEdge && 0 !== this.Yu.length ? this.k_ / this.Yu.length : this.yn.minBarSpacing; };
        zi.prototype.cc = function () { var _j; if (!this.yn.enableConflation)
            return void (this.ac = 1); var t = 1 / (window.devicePixelRatio || 1) * ((_j = this.yn.conflationThresholdFactor) !== null && _j !== void 0 ? _j : 1); if (this.oc >= t)
            return void (this.ac = 1); var i = t / this.oc, n = Math.pow(2, Math.floor(Math.log2(i))); this.ac = Math.min(n, 512); };
        zi.prototype.Rc = function () { var t = this.od(); null !== t && this.lc < t && (this.lc = t, this.Xu = !0); var i = this._d(); this.lc > i && (this.lc = i, this.Xu = !0); };
        zi.prototype.od = function () { var t = this.yc(), i = this.qu; if (null === t || null === i)
            return null; return t - i - 1 + (this.yn.fixLeftEdge ? this.k_ / this.oc : Math.min(2, this.Yu.length)); };
        zi.prototype._d = function () { return this.yn.fixRightEdge ? 0 : this.k_ / this.oc - Math.min(2, this.Yu.length); };
        zi.prototype.$c = function () { this.nc = { ml: this.ml(), Oc: this.Oc() }; };
        zi.prototype.jc = function () { this.nc = null; };
        zi.prototype.Fc = function (t) {
            var _this = this;
            var i = this.Gu.get(t.weight);
            return void 0 === i && (i = new Di((function (t) { return _this.ud(t); }), this.Pu), this.Gu.set(t.weight, i)), i.ku(t);
        };
        zi.prototype.ud = function (t) { return this.Pu.formatTickmark(t, this.Do); };
        zi.prototype.hd = function (t) { var i = this.Zu; this.Zu = t, Vi(i.Uu(), this.Zu.Uu()) || this.Ju.p(), Vi(i.$u(), this.Zu.$u()) || this.Qu.p(), this.rd(); };
        zi.prototype.rd = function () { this.sc = null; };
        zi.prototype.vc = function () { this.rd(), this.Gu.clear(); };
        zi.prototype.uc = function () { this.Pu.updateFormatter(this.Do); };
        zi.prototype.mc = function () { if (!this.yn.fixLeftEdge)
            return; var t = this.yc(); if (null === t)
            return; var i = this.Be(); if (null === i)
            return; var n = i.Na() - t; if (n < 0) {
            var t_46 = this.lc - n - 1;
            this.Ms(t_46);
        } this.Tc(); };
        zi.prototype.wc = function () { this.Rc(), this.Tc(); };
        zi.prototype.Bc = function (t) { return !this.yn.ignoreWhitespaceIndices || (this.ec.get(t) || !1); };
        zi.prototype.Ac = function (t) { var i = function (t) { var i, n, s, _j; return __generator(this, function (_k) {
            switch (_k.label) {
                case 0:
                    i = Math.round(t), n = i < t;
                    s = 1;
                    _k.label = 1;
                case 1:
                    if (!n) return [3 /*break*/, 4];
                    return [4 /*yield*/, i + s];
                case 2:
                    _k.sent();
                    return [4 /*yield*/, i - s];
                case 3:
                    _j = (_k.sent());
                    return [3 /*break*/, 7];
                case 4: return [4 /*yield*/, i - s];
                case 5:
                    _k.sent();
                    return [4 /*yield*/, i + s];
                case 6:
                    _j = (_k.sent());
                    _k.label = 7;
                case 7:
                    _j, s++;
                    _k.label = 8;
                case 8: return [3 /*break*/, 1];
                case 9: return [2 /*return*/];
            }
        }); }(t), n = this.Pc(); for (; n;) {
            var t_47 = i.next().value;
            if (this.ec.get(t_47))
                return t_47;
            if (t_47 < 0 || t_47 > n)
                break;
        } return t; };
        zi.prototype._c = function (t) { if (void 0 !== t.rightOffsetPixels) {
            var i_40 = t.rightOffsetPixels / (t.barSpacing || this.oc);
            this.sn.Ms(i_40);
        } };
        return zi;
    }());
    var Li, Oi, Ni, Fi, Wi;
    !function (t) { t[t.OnTouchEnd = 0] = "OnTouchEnd", t[t.OnNextTap = 1] = "OnNextTap"; }(Li || (Li = {}));
    var Hi = /** @class */ (function () {
        function Hi(t, i, n) {
            this.dd = [], this.fd = [], this.pd = null, this.k_ = 0, this.vd = null, this.md = new o, this.wd = new o, this.gd = null, this.Md = t, this.yn = i, this.Pu = n, this.Io = new x(this.yn.layout.colorParsers), this.bd = new M(this), this.ia = new zi(this, i.timeScale, this.yn.localization, n), this.Ct = new j(this, i.crosshair), this.Sd = new Xt(i.crosshair), i.addDefaultPane && (this.xd(0), this.dd[0].W_(2)), this.Cd = this.yd(0), this.Pd = this.yd(1);
        }
        Hi.prototype.ka = function () { this.kd(Y.ys()); };
        Hi.prototype.mr = function () { this.kd(Y.Cs()); };
        Hi.prototype.Ya = function () { this.kd(new Y(1)); };
        Hi.prototype.Ta = function (t) { var i = this.Td(t); this.kd(i); };
        Hi.prototype.cu = function () { return this.vd; };
        Hi.prototype.Rd = function (t) { var _j, _k, _q, _y, _z, _0, _5, _6, _7; if (((_j = this.vd) === null || _j === void 0 ? void 0 : _j.uu) === (t === null || t === void 0 ? void 0 : t.uu) && ((_q = (_k = this.vd) === null || _k === void 0 ? void 0 : _k.bu) === null || _q === void 0 ? void 0 : _q.te) === ((_y = t === null || t === void 0 ? void 0 : t.bu) === null || _y === void 0 ? void 0 : _y.te) && ((_0 = (_z = this.vd) === null || _z === void 0 ? void 0 : _z.bu) === null || _0 === void 0 ? void 0 : _0.ie) === ((_5 = t === null || t === void 0 ? void 0 : t.bu) === null || _5 === void 0 ? void 0 : _5.ie) && ((_6 = this.vd) === null || _6 === void 0 ? void 0 : _6.Mu) === (t === null || t === void 0 ? void 0 : t.Mu) && ((_7 = this.vd) === null || _7 === void 0 ? void 0 : _7.ee) === (t === null || t === void 0 ? void 0 : t.ee))
            return; var i = this.vd; this.vd = t, null !== i && this.Ta(i.uu), null !== t && t.uu !== (i === null || i === void 0 ? void 0 : i.uu) && this.Ta(t.uu); };
        Hi.prototype.N = function () { return this.yn; };
        Hi.prototype.vr = function (t) { _(this.yn, t), this.dd.forEach((function (i) { return i.L_(t); })), void 0 !== t.timeScale && this.ia.vr(t.timeScale), void 0 !== t.localization && this.ia.fc(t.localization), (t.leftPriceScale || t.rightPriceScale) && this.md.p(), this.Cd = this.yd(0), this.Pd = this.yd(1), this.ka(); };
        Hi.prototype.Dd = function (t, i, n) {
            if (n === void 0) { n = 0; }
            var s = this.dd[n];
            if (void 0 === s)
                return;
            if ("left" === t)
                return _(this.yn, { leftPriceScale: i }), s.L_({ leftPriceScale: i }), this.md.p(), void this.ka();
            if ("right" === t)
                return _(this.yn, { rightPriceScale: i }), s.L_({ rightPriceScale: i }), this.md.p(), void this.ka();
            var e = this.Id(t, n);
            null !== e && (e.Ft.vr(i), this.md.p());
        };
        Hi.prototype.Id = function (t, i) { var n = this.dd[i]; if (void 0 === n)
            return null; var s = n.O_(t); return null !== s ? { Kn: n, Ft: s } : null; };
        Hi.prototype.Bt = function () { return this.ia; };
        Hi.prototype.Gn = function () { return this.dd; };
        Hi.prototype.Vd = function () { return this.Ct; };
        Hi.prototype.Ed = function () { return this.wd; };
        Hi.prototype.Bd = function (t, i) { t.$o(i), this.zc(); };
        Hi.prototype.H_ = function (t) { this.k_ = t, this.ia.H_(this.k_), this.dd.forEach((function (i) { return i.H_(t); })), this.zc(); };
        Hi.prototype.Ad = function (t) { 1 !== this.dd.length && (r(t >= 0 && t < this.dd.length, "Invalid pane index"), this.dd.splice(t, 1), this.ka()); };
        Hi.prototype.zd = function (t, i) { if (this.dd.length < 2)
            return; r(t >= 0 && t < this.dd.length, "Invalid pane index"); var n = this.dd[t], s = this.dd.reduce((function (t, i) { return t + i.F_(); }), 0), e = this.dd.reduce((function (t, i) { return t + i.$t(); }), 0), h = e - 30 * (this.dd.length - 1); i = Math.min(h, Math.max(30, i)); var a = s / e, l = n.$t(); n.W_(i * a); var o = i - l, _ = this.dd.length - 1; for (var _j = 0, _k = this.dd; _j < _k.length; _j++) {
            var t_48 = _k[_j];
            if (t_48 !== n) {
                var i_41 = Math.min(h, Math.max(30, t_48.$t() - o / _));
                o -= t_48.$t() - i_41, _ -= 1;
                var n_25 = i_41 * a;
                t_48.W_(n_25);
            }
        } this.ka(); };
        Hi.prototype.Ld = function (t, i) { r(t >= 0 && t < this.dd.length && i >= 0 && i < this.dd.length, "Invalid pane index"); var n = this.dd[t], s = this.dd[i]; this.dd[t] = s, this.dd[i] = n, this.ka(); };
        Hi.prototype.Od = function (t, i) { if (r(t >= 0 && t < this.dd.length && i >= 0 && i < this.dd.length, "Invalid pane index"), t === i)
            return; var n = this.dd.splice(t, 1)[0]; this.dd.splice(i, 0, n), this.ka(); };
        Hi.prototype.Q_ = function (t, i, n) { t.Q_(i, n); };
        Hi.prototype.tu = function (t, i, n) { t.tu(i, n), this.Ra(), this.kd(this.Nd(t, 2)); };
        Hi.prototype.iu = function (t, i) { t.iu(i), this.kd(this.Nd(t, 2)); };
        Hi.prototype.nu = function (t, i, n) { i.Lo() || t.nu(i, n); };
        Hi.prototype.su = function (t, i, n) { i.Lo() || (t.su(i, n), this.Ra(), this.kd(this.Nd(t, 2))); };
        Hi.prototype.eu = function (t, i) { i.Lo() || (t.eu(i), this.kd(this.Nd(t, 2))); };
        Hi.prototype.au = function (t, i) { t.au(i), this.kd(this.Nd(t, 2)); };
        Hi.prototype.Fd = function (t) { this.ia.u_(t); };
        Hi.prototype.Wd = function (t, i) { var n = this.Bt(); if (n.Zi() || 0 === i)
            return; var s = n.nn(); t = Math.max(1, Math.min(t, s)), n.Uc(t, i), this.zc(); };
        Hi.prototype.Hd = function (t) { this.Ud(0), this.$d(t), this.jd(); };
        Hi.prototype.qd = function (t) { this.ia.c_(t), this.zc(); };
        Hi.prototype.Yd = function () { this.ia.d_(), this.mr(); };
        Hi.prototype.Ud = function (t) { this.ia.f_(t); };
        Hi.prototype.$d = function (t) { this.ia.p_(t), this.zc(); };
        Hi.prototype.jd = function () { this.ia.v_(), this.mr(); };
        Hi.prototype.Jn = function () { return this.fd; };
        Hi.prototype.Wn = function () { return null === this.pd && (this.pd = this.fd.filter((function (t) { return t.It(); }))), this.pd; };
        Hi.prototype.Pa = function () { this.pd = null; };
        Hi.prototype.Kd = function (t, i, n, s, e) { this.Ct.In(t, i); var r = NaN, h = this.ia.Vc(t, !0); var a = this.ia.Be(); null !== a && (h = Math.min(Math.max(a.Na(), h), a.bi())), h = this.Ct.Fn(h); var l = s.kn(), o = l.zt(); if (null !== o && (r = l.Tn(i, o)), r = this.Sd.Pl(r, h, s), this.Ct.An(h, r, s), this.Ya(), !e) {
            var e_10 = Ri(s, t, i);
            this.Rd(e_10 && { uu: e_10.uu, bu: e_10.bu, Mu: e_10.Mu || null, ee: e_10.ee }), this.wd.p(this.Ct.Et(), { x: t, y: i }, n);
        } };
        Hi.prototype.Gd = function (t, i, n) { var s = n.kn(), e = s.zt(), r = s.Nt(t, a(e)), h = this.ia.gc(i, !0), l = this.ia.jt(a(h)); this.Kd(l, r, null, n, !0); };
        Hi.prototype.Zd = function (t) { this.Vd().Ln(), this.Ya(), t || this.wd.p(null, null, null); };
        Hi.prototype.Ra = function () { var t = this.Ct.Kn(); if (null !== t) {
            var i_42 = this.Ct.En(), n_26 = this.Ct.Bn();
            this.Kd(i_42, n_26, null, t);
        } this.Ct.Nn(); };
        Hi.prototype.Xd = function (t, i, n) { var s = this.ia.Rn(0); void 0 !== i && void 0 !== n && this.ia.Pt(i, n); var e = this.ia.Rn(0), r = this.ia.Dc(), h = this.ia.Be(); if (null !== h && null !== s && null !== e) {
            var i_43 = h.Le(r), a_9 = this.Pu.key(s) > this.Pu.key(e), l_9 = null !== t && t > r && !a_9, o_6 = this.ia.N().allowShiftVisibleRangeOnWhitespaceReplacement, _5 = i_43 && (!(void 0 === n) || o_6) && this.ia.N().shiftVisibleRangeOnNewBar;
            if (l_9 && !_5) {
                var i_44 = t - r;
                this.ia.Ms(this.ia.Oc() - i_44);
            }
        } this.ia.Hc(t); };
        Hi.prototype.Ea = function (t) { null !== t && t.ou(); };
        Hi.prototype.Ks = function (t) { if (function (t) { return t instanceof Si; }(t))
            return t; var i = this.dd.find((function (i) { return i.Dt().includes(t); })); return void 0 === i ? null : i; };
        Hi.prototype.zc = function () { this.dd.forEach((function (t) { return t.ou(); })), this.Ra(); };
        Hi.prototype.m = function () { this.dd.forEach((function (t) { return t.m(); })), this.dd.length = 0, this.yn.localization.priceFormatter = void 0, this.yn.localization.percentageFormatter = void 0, this.yn.localization.timeFormatter = void 0; };
        Hi.prototype.Jd = function () { return this.bd; };
        Hi.prototype.Js = function () { return this.bd.N(); };
        Hi.prototype.N_ = function () { return this.md; };
        Hi.prototype.Qd = function (t, i) { var n = this.xd(i); this.tf(t, n), this.fd.push(t), this.Pa(), 1 === this.fd.length ? this.ka() : this.mr(); };
        Hi.prototype.if = function (t) { var i = this.Ks(t), n = this.fd.indexOf(t); r(-1 !== n, "Series not found"); var s = a(i); this.fd.splice(n, 1), s.l_(t), t.m && t.m(), this.Pa(), this.ia.dc(), this.nf(s); };
        Hi.prototype.ya = function (t, i) { var n = a(this.Ks(t)); n.l_(t, !0), n.h_(t, i, !0); };
        Hi.prototype.td = function () { var t = Y.Cs(); t.us(), this.kd(t); };
        Hi.prototype.sf = function (t) { var i = Y.Cs(); i.fs(t), this.kd(i); };
        Hi.prototype.ws = function () { var t = Y.Cs(); t.ws(), this.kd(t); };
        Hi.prototype.gs = function (t) { var i = Y.Cs(); i.gs(t), this.kd(i); };
        Hi.prototype.Ms = function (t) { var i = Y.Cs(); i.Ms(t), this.kd(i); };
        Hi.prototype.ps = function (t) { var i = Y.Cs(); i.ps(t), this.kd(i); };
        Hi.prototype.cs = function () { var t = Y.Cs(); t.cs(), this.kd(t); };
        Hi.prototype.ef = function () { var t = this.yn.defaultVisiblePriceScaleId, i = this.yn.leftPriceScale.visible; return i !== this.yn.rightPriceScale.visible ? i ? "left" : "right" : t; };
        Hi.prototype.rf = function (t, i) { r(i >= 0, "Index should be greater or equal to 0"); if (i === this.hf(t))
            return; var n = a(this.Ks(t)); n.l_(t); var s = this.xd(i); this.tf(t, s); var e = !1; 0 === n.kl().length && (e = this.nf(n)), e || this.ka(); };
        Hi.prototype.af = function () { return this.Pd; };
        Hi.prototype.$ = function () { return this.Cd; };
        Hi.prototype.Ut = function (t) { var i = this.Pd, n = this.Cd; if (i === n)
            return i; if (t = Math.max(0, Math.min(100, Math.round(100 * t))), null === this.gd || this.gd.ah !== n || this.gd.oh !== i)
            this.gd = { ah: n, oh: i, lf: new Map };
        else {
            var i_45 = this.gd.lf.get(t);
            if (void 0 !== i_45)
                return i_45;
        } var s = this.Io.tt(n, i, t / 100); return this.gd.lf.set(t, s), s; };
        Hi.prototype._f = function (t) { return this.dd.indexOf(t); };
        Hi.prototype.Xi = function () { return this.Io; };
        Hi.prototype.uf = function () { return this.cf(); };
        Hi.prototype.cf = function (t) { var i = new Si(this.ia, this); this.dd.push(i); var n = t !== null && t !== void 0 ? t : this.dd.length - 1, s = Y.ys(); return s.es(n, { rs: 0, hs: !0 }), this.kd(s), i; };
        Hi.prototype.xd = function (t) { return r(t >= 0, "Index should be greater or equal to 0"), (t = Math.min(this.dd.length, t)) < this.dd.length ? this.dd[t] : this.cf(t); };
        Hi.prototype.hf = function (t) { return this.dd.findIndex((function (i) { return i.Y_().includes(t); })); };
        Hi.prototype.Nd = function (t, i) { var n = new Y(i); if (null !== t) {
            var s_15 = this.dd.indexOf(t);
            n.es(s_15, { rs: i });
        } return n; };
        Hi.prototype.Td = function (t, i) { return void 0 === i && (i = 2), this.Nd(this.Ks(t), i); };
        Hi.prototype.kd = function (t) { this.Md && this.Md(t), this.dd.forEach((function (t) { return t.wu().wr().Pt(); })); };
        Hi.prototype.tf = function (t, i) { var n = t.N().priceScaleId, s = void 0 !== n ? n : this.ef(); i.h_(t, s), q(s) || t.vr(t.N()); };
        Hi.prototype.yd = function (t) { var i = this.yn.layout; return "gradient" === i.background.type ? 0 === t ? i.background.topColor : i.background.bottomColor : i.background.color; };
        Hi.prototype.nf = function (t) { return !t.q_() && 0 === t.kl().length && this.dd.length > 1 && (this.dd.splice(this._f(t), 1), this.ka(), !0); };
        return Hi;
    }());
    function Ui(t) { if (t >= 1)
        return 0; var i = 0; for (; i < 8; i++) {
        var n_27 = Math.round(t);
        if (Math.abs(n_27 - t) < 1e-8)
            return i;
        t *= 10;
    } return i; }
    function $i(t) { return !u(t) && !d(t); }
    function ji(t) { return u(t); }
    !function (t) { t[t.Disabled = 0] = "Disabled", t[t.Continuous = 1] = "Continuous", t[t.OnDataUpdate = 2] = "OnDataUpdate"; }(Oi || (Oi = {})), function (t) { t[t.LastBar = 0] = "LastBar", t[t.LastVisible = 1] = "LastVisible"; }(Ni || (Ni = {})), function (t) { t.Solid = "solid", t.VerticalGradient = "gradient"; }(Fi || (Fi = {})), function (t) { t[t.Year = 0] = "Year", t[t.Month = 1] = "Month", t[t.DayOfMonth = 2] = "DayOfMonth", t[t.Time = 3] = "Time", t[t.TimeWithSeconds = 4] = "TimeWithSeconds"; }(Wi || (Wi = {}));
    var qi = function (t) { return t.getUTCFullYear(); };
    function Yi(t, i, n) { return i.replace(/yyyy/g, (function (t) { return Z(qi(t), 4); })(t)).replace(/yy/g, (function (t) { return Z(qi(t) % 100, 2); })(t)).replace(/MMMM/g, (function (t, i) { return new Date(t.getUTCFullYear(), t.getUTCMonth(), 1).toLocaleString(i, { month: "long" }); })(t, n)).replace(/MMM/g, (function (t, i) { return new Date(t.getUTCFullYear(), t.getUTCMonth(), 1).toLocaleString(i, { month: "short" }); })(t, n)).replace(/MM/g, (function (t) { return Z((function (t) { return t.getUTCMonth() + 1; })(t), 2); })(t)).replace(/dd/g, (function (t) { return Z((function (t) { return t.getUTCDate(); })(t), 2); })(t)); }
    var Ki = /** @class */ (function () {
        function Ki(t, i) {
            if (t === void 0) { t = "yyyy-MM-dd"; }
            if (i === void 0) { i = "default"; }
            this.df = t, this.ff = i;
        }
        Ki.prototype.ku = function (t) { return Yi(t, this.df, this.ff); };
        return Ki;
    }());
    var Gi = /** @class */ (function () {
        function Gi(t) {
            this.pf = t || "%h:%m:%s";
        }
        Gi.prototype.ku = function (t) { return this.pf.replace("%h", Z(t.getUTCHours(), 2)).replace("%m", Z(t.getUTCMinutes(), 2)).replace("%s", Z(t.getUTCSeconds(), 2)); };
        return Gi;
    }());
    var Zi = { vf: "yyyy-MM-dd", mf: "%h:%m:%s", wf: " ", gf: "default" };
    var Xi = /** @class */ (function () {
        function Xi(t) {
            if (t === void 0) { t = {}; }
            var i = __assign(__assign({}, Zi), t);
            this.Mf = new Ki(i.vf, i.gf), this.bf = new Gi(i.mf), this.Sf = i.wf;
        }
        Xi.prototype.ku = function (t) { return "".concat(this.Mf.ku(t)).concat(this.Sf).concat(this.bf.ku(t)); };
        return Xi;
    }());
    function Ji(t) { return 60 * t * 60 * 1e3; }
    function Qi(t) { return 60 * t * 1e3; }
    var tn = [{ xf: (nn = 1, 1e3 * nn), Cf: 10 }, { xf: Qi(1), Cf: 20 }, { xf: Qi(5), Cf: 21 }, { xf: Qi(30), Cf: 22 }, { xf: Ji(1), Cf: 30 }, { xf: Ji(3), Cf: 31 }, { xf: Ji(6), Cf: 32 }, { xf: Ji(12), Cf: 33 }];
    var nn;
    function sn(t, i) { if (t.getUTCFullYear() !== i.getUTCFullYear())
        return 70; if (t.getUTCMonth() !== i.getUTCMonth())
        return 60; if (t.getUTCDate() !== i.getUTCDate())
        return 50; for (var n_28 = tn.length - 1; n_28 >= 0; --n_28)
        if (Math.floor(i.getTime() / tn[n_28].xf) !== Math.floor(t.getTime() / tn[n_28].xf))
            return tn[n_28].Cf; return 0; }
    function en(t) { var i = t; if (d(t) && (i = hn(t)), !$i(i))
        throw new Error("time must be of type BusinessDay"); var n = new Date(Date.UTC(i.year, i.month - 1, i.day, 0, 0, 0, 0)); return { yf: Math.round(n.getTime() / 1e3), Pf: i }; }
    function rn(t) { if (!ji(t))
        throw new Error("time must be of type isUTCTimestamp"); return { yf: t }; }
    function hn(t) { var i = new Date(t); if (isNaN(i.getTime()))
        throw new Error("Invalid date string=".concat(t, ", expected format=yyyy-mm-dd")); return { day: i.getUTCDate(), month: i.getUTCMonth() + 1, year: i.getUTCFullYear() }; }
    function an(t) { d(t.time) && (t.time = hn(t.time)); }
    var ln = /** @class */ (function () {
        function ln() {
        }
        ln.prototype.options = function () { return this.yn; };
        ln.prototype.setOptions = function (t) { this.yn = t, this.updateFormatter(t.localization); };
        ln.prototype.preprocessData = function (t) { Array.isArray(t) ? function (t) { t.forEach(an); }(t) : an(t); };
        ln.prototype.createConverterToInternalObj = function (t) { return a(function (t) { return 0 === t.length ? null : $i(t[0].time) || d(t[0].time) ? en : rn; }(t)); };
        ln.prototype.key = function (t) { return "object" == typeof t && "yf" in t ? t.yf : this.key(this.convertHorzItemToInternal(t)); };
        ln.prototype.cacheKey = function (t) { var i = t; return void 0 === i.Pf ? new Date(1e3 * i.yf).getTime() : new Date(Date.UTC(i.Pf.year, i.Pf.month - 1, i.Pf.day)).getTime(); };
        ln.prototype.convertHorzItemToInternal = function (t) { return ji(i = t) ? rn(i) : $i(i) ? en(i) : en(hn(i)); var i; };
        ln.prototype.updateFormatter = function (t) { if (!this.yn)
            return; var i = t.dateFormat; this.yn.timeScale.timeVisible ? this.kf = new Xi({ vf: i, mf: this.yn.timeScale.secondsVisible ? "%h:%m:%s" : "%h:%m", wf: "   ", gf: t.locale }) : this.kf = new Ki(i, t.locale); };
        ln.prototype.formatHorzItem = function (t) { var i = t; return this.kf.ku(new Date(1e3 * i.yf)); };
        ln.prototype.formatTickmark = function (t, i) { var n = function (t, i, n) { switch (t) {
            case 0:
            case 10: return i ? n ? 4 : 3 : 2;
            case 20:
            case 21:
            case 22:
            case 30:
            case 31:
            case 32:
            case 33: return i ? 3 : 2;
            case 50: return 2;
            case 60: return 1;
            case 70: return 0;
        } }(t.weight, this.yn.timeScale.timeVisible, this.yn.timeScale.secondsVisible), s = this.yn.timeScale; if (void 0 !== s.tickMarkFormatter) {
            var e_11 = s.tickMarkFormatter(t.originalTime, n, i.locale);
            if (null !== e_11)
                return e_11;
        } return function (t, i, n) { var s = {}; switch (i) {
            case 0:
                s.year = "numeric";
                break;
            case 1:
                s.month = "short";
                break;
            case 2:
                s.day = "numeric";
                break;
            case 3:
                s.hour12 = !1, s.hour = "2-digit", s.minute = "2-digit";
                break;
            case 4: s.hour12 = !1, s.hour = "2-digit", s.minute = "2-digit", s.second = "2-digit";
        } var e = void 0 === t.Pf ? new Date(1e3 * t.yf) : new Date(Date.UTC(t.Pf.year, t.Pf.month - 1, t.Pf.day)); return new Date(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate(), e.getUTCHours(), e.getUTCMinutes(), e.getUTCSeconds(), e.getUTCMilliseconds()).toLocaleString(n, s); }(t.time, n, i.locale); };
        ln.prototype.maxTickMarkWeight = function (t) { var i = t.reduce(Ai, t[0]).weight; return i > 30 && i < 50 && (i = 30), i; };
        ln.prototype.fillWeightsForPoints = function (t, i) { !function (t, i) {
            if (i === void 0) { i = 0; }
            if (0 === t.length)
                return;
            var n = 0 === i ? null : t[i - 1].time.yf, s = null !== n ? new Date(1e3 * n) : null, e = 0;
            for (var r_9 = i; r_9 < t.length; ++r_9) {
                var i_46 = t[r_9], h_7 = new Date(1e3 * i_46.time.yf);
                null !== s && (i_46.timeWeight = sn(h_7, s)), e += i_46.time.yf - (n || i_46.time.yf), n = i_46.time.yf, s = h_7;
            }
            if (0 === i && t.length > 1) {
                var i_47 = Math.ceil(e / (t.length - 1)), n_29 = new Date(1e3 * (t[0].time.yf - i_47));
                t[0].timeWeight = sn(new Date(1e3 * t[0].time.yf), n_29);
            }
        }(t, i); };
        ln.Tf = function (t) { return _({ localization: { dateFormat: "dd MMM 'yy" } }, t !== null && t !== void 0 ? t : {}); };
        return ln;
    }());
    function on(t) { var i = t.width, n = t.height; if (i < 0)
        throw new Error("Negative width is not allowed for Size"); if (n < 0)
        throw new Error("Negative height is not allowed for Size"); return { width: i, height: n }; }
    function _n(t, i) { return t.width === i.width && t.height === i.height; }
    var un = function () { function t(t) { var i = this; this._resolutionListener = function () { return i._onResolutionChanged(); }, this._resolutionMediaQueryList = null, this._observers = [], this._window = t, this._installResolutionListener(); } return t.prototype.dispose = function () { this._uninstallResolutionListener(), this._window = null; }, Object.defineProperty(t.prototype, "value", { get: function () { return this._window.devicePixelRatio; }, enumerable: !1, configurable: !0 }), t.prototype.subscribe = function (t) { var i = this, n = { next: t }; return this._observers.push(n), { unsubscribe: function () { i._observers = i._observers.filter((function (t) { return t !== n; })); } }; }, t.prototype._installResolutionListener = function () { if (null !== this._resolutionMediaQueryList)
        throw new Error("Resolution listener is already installed"); var t = this._window.devicePixelRatio; this._resolutionMediaQueryList = this._window.matchMedia("all and (resolution: ".concat(t, "dppx)")), this._resolutionMediaQueryList.addListener(this._resolutionListener); }, t.prototype._uninstallResolutionListener = function () { null !== this._resolutionMediaQueryList && (this._resolutionMediaQueryList.removeListener(this._resolutionListener), this._resolutionMediaQueryList = null); }, t.prototype._reinstallResolutionListener = function () { this._uninstallResolutionListener(), this._installResolutionListener(); }, t.prototype._onResolutionChanged = function () { var t = this; this._observers.forEach((function (i) { return i.next(t._window.devicePixelRatio); })), this._reinstallResolutionListener(); }, t; }();
    var cn = function () { function t(t, i, n) { var s; this._canvasElement = null, this._bitmapSizeChangedListeners = [], this._suggestedBitmapSize = null, this._suggestedBitmapSizeChangedListeners = [], this._devicePixelRatioObservable = null, this._canvasElementResizeObserver = null, this._canvasElement = t, this._canvasElementClientSize = on({ width: this._canvasElement.clientWidth, height: this._canvasElement.clientHeight }), this._transformBitmapSize = null != i ? i : function (t) { return t; }, this._allowResizeObserver = null === (s = null == n ? void 0 : n.allowResizeObserver) || void 0 === s || s, this._chooseAndInitObserver(); } return t.prototype.dispose = function () { var t, i; if (null === this._canvasElement)
        throw new Error("Object is disposed"); null === (t = this._canvasElementResizeObserver) || void 0 === t || t.disconnect(), this._canvasElementResizeObserver = null, null === (i = this._devicePixelRatioObservable) || void 0 === i || i.dispose(), this._devicePixelRatioObservable = null, this._suggestedBitmapSizeChangedListeners.length = 0, this._bitmapSizeChangedListeners.length = 0, this._canvasElement = null; }, Object.defineProperty(t.prototype, "canvasElement", { get: function () { if (null === this._canvasElement)
            throw new Error("Object is disposed"); return this._canvasElement; }, enumerable: !1, configurable: !0 }), Object.defineProperty(t.prototype, "canvasElementClientSize", { get: function () { return this._canvasElementClientSize; }, enumerable: !1, configurable: !0 }), Object.defineProperty(t.prototype, "bitmapSize", { get: function () { return on({ width: this.canvasElement.width, height: this.canvasElement.height }); }, enumerable: !1, configurable: !0 }), t.prototype.resizeCanvasElement = function (t) { this._canvasElementClientSize = on(t), this.canvasElement.style.width = "".concat(this._canvasElementClientSize.width, "px"), this.canvasElement.style.height = "".concat(this._canvasElementClientSize.height, "px"), this._invalidateBitmapSize(); }, t.prototype.subscribeBitmapSizeChanged = function (t) { this._bitmapSizeChangedListeners.push(t); }, t.prototype.unsubscribeBitmapSizeChanged = function (t) { this._bitmapSizeChangedListeners = this._bitmapSizeChangedListeners.filter((function (i) { return i !== t; })); }, Object.defineProperty(t.prototype, "suggestedBitmapSize", { get: function () { return this._suggestedBitmapSize; }, enumerable: !1, configurable: !0 }), t.prototype.subscribeSuggestedBitmapSizeChanged = function (t) { this._suggestedBitmapSizeChangedListeners.push(t); }, t.prototype.unsubscribeSuggestedBitmapSizeChanged = function (t) { this._suggestedBitmapSizeChangedListeners = this._suggestedBitmapSizeChangedListeners.filter((function (i) { return i !== t; })); }, t.prototype.applySuggestedBitmapSize = function () { if (null !== this._suggestedBitmapSize) {
        var t = this._suggestedBitmapSize;
        this._suggestedBitmapSize = null, this._resizeBitmap(t), this._emitSuggestedBitmapSizeChanged(t, this._suggestedBitmapSize);
    } }, t.prototype._resizeBitmap = function (t) { var i = this.bitmapSize; _n(i, t) || (this.canvasElement.width = t.width, this.canvasElement.height = t.height, this._emitBitmapSizeChanged(i, t)); }, t.prototype._emitBitmapSizeChanged = function (t, i) { var n = this; this._bitmapSizeChangedListeners.forEach((function (s) { return s.call(n, t, i); })); }, t.prototype._suggestNewBitmapSize = function (t) { var i = this._suggestedBitmapSize, n = on(this._transformBitmapSize(t, this._canvasElementClientSize)), s = _n(this.bitmapSize, n) ? null : n; null === i && null === s || null !== i && null !== s && _n(i, s) || (this._suggestedBitmapSize = s, this._emitSuggestedBitmapSizeChanged(i, s)); }, t.prototype._emitSuggestedBitmapSizeChanged = function (t, i) { var n = this; this._suggestedBitmapSizeChangedListeners.forEach((function (s) { return s.call(n, t, i); })); }, t.prototype._chooseAndInitObserver = function () { var t = this; this._allowResizeObserver ? new Promise((function (t) { var i = new ResizeObserver((function (n) { t(n.every((function (t) { return "devicePixelContentBoxSize" in t; }))), i.disconnect(); })); i.observe(document.body, { box: "device-pixel-content-box" }); })).catch((function () { return !1; })).then((function (i) { return i ? t._initResizeObserver() : t._initDevicePixelRatioObservable(); })) : this._initDevicePixelRatioObservable(); }, t.prototype._initDevicePixelRatioObservable = function () { var t = this; if (null !== this._canvasElement) {
        var i = dn(this._canvasElement);
        if (null === i)
            throw new Error("No window is associated with the canvas");
        this._devicePixelRatioObservable = function (t) { return new un(t); }(i), this._devicePixelRatioObservable.subscribe((function () { return t._invalidateBitmapSize(); })), this._invalidateBitmapSize();
    } }, t.prototype._invalidateBitmapSize = function () { var t, i; if (null !== this._canvasElement) {
        var n = dn(this._canvasElement);
        if (null !== n) {
            var s = null !== (i = null === (t = this._devicePixelRatioObservable) || void 0 === t ? void 0 : t.value) && void 0 !== i ? i : n.devicePixelRatio, e = this._canvasElement.getClientRects(), r = void 0 !== e[0] ? function (t, i) { return on({ width: Math.round(t.left * i + t.width * i) - Math.round(t.left * i), height: Math.round(t.top * i + t.height * i) - Math.round(t.top * i) }); }(e[0], s) : on({ width: this._canvasElementClientSize.width * s, height: this._canvasElementClientSize.height * s });
            this._suggestNewBitmapSize(r);
        }
    } }, t.prototype._initResizeObserver = function () { var t = this; null !== this._canvasElement && (this._canvasElementResizeObserver = new ResizeObserver((function (i) { var n = i.find((function (i) { return i.target === t._canvasElement; })); if (n && n.devicePixelContentBoxSize && n.devicePixelContentBoxSize[0]) {
        var s = n.devicePixelContentBoxSize[0], e = on({ width: s.inlineSize, height: s.blockSize });
        t._suggestNewBitmapSize(e);
    } })), this._canvasElementResizeObserver.observe(this._canvasElement, { box: "device-pixel-content-box" })); }, t; }();
    function dn(t) { return t.ownerDocument.defaultView; }
    var fn = function () { function t(t, i, n) { if (0 === i.width || 0 === i.height)
        throw new TypeError("Rendering target could only be created on a media with positive width and height"); if (this._mediaSize = i, 0 === n.width || 0 === n.height)
        throw new TypeError("Rendering target could only be created using a bitmap with positive integer width and height"); this._bitmapSize = n, this._context = t; } return t.prototype.useMediaCoordinateSpace = function (t) { try {
        return this._context.save(), this._context.setTransform(1, 0, 0, 1, 0, 0), this._context.scale(this._horizontalPixelRatio, this._verticalPixelRatio), t({ context: this._context, mediaSize: this._mediaSize });
    }
    finally {
        this._context.restore();
    } }, t.prototype.useBitmapCoordinateSpace = function (t) { try {
        return this._context.save(), this._context.setTransform(1, 0, 0, 1, 0, 0), t({ context: this._context, mediaSize: this._mediaSize, bitmapSize: this._bitmapSize, horizontalPixelRatio: this._horizontalPixelRatio, verticalPixelRatio: this._verticalPixelRatio });
    }
    finally {
        this._context.restore();
    } }, Object.defineProperty(t.prototype, "_horizontalPixelRatio", { get: function () { return this._bitmapSize.width / this._mediaSize.width; }, enumerable: !1, configurable: !0 }), Object.defineProperty(t.prototype, "_verticalPixelRatio", { get: function () { return this._bitmapSize.height / this._mediaSize.height; }, enumerable: !1, configurable: !0 }), t; }();
    function pn(t, i) { var n = t.canvasElementClientSize; if (0 === n.width || 0 === n.height)
        return null; var s = t.bitmapSize; if (0 === s.width || 0 === s.height)
        return null; var e = t.canvasElement.getContext("2d", i); return null === e ? null : new fn(e, n, s); }
    var vn = "undefined" != typeof window;
    function mn() { return !!vn && window.navigator.userAgent.toLowerCase().indexOf("firefox") > -1; }
    function wn() { return !!vn && /iPhone|iPad|iPod/.test(window.navigator.platform); }
    function gn(t, i) { switch (t) {
        case "custom": return void 0 !== i ? "custom-object" : "series";
        case "price-line": return "custom-price-line";
        case "marker": return "series-marker";
        case "primitive": return "primitive";
        default: return "series";
    } }
    function Mn(t) { return t + t % 2; }
    function bn(t) { vn && void 0 !== window.chrome && t.addEventListener("mousedown", (function (t) { if (1 === t.button)
        return t.preventDefault(), !1; })); }
    var Sn = /** @class */ (function () {
        function Sn(t, i, n) {
            var _this = this;
            this.Rf = 0, this.Df = null, this.If = { _t: Number.NEGATIVE_INFINITY, ut: Number.POSITIVE_INFINITY }, this.Vf = 0, this.Ef = null, this.Bf = { _t: Number.NEGATIVE_INFINITY, ut: Number.POSITIVE_INFINITY }, this.Af = null, this.zf = !1, this.Lf = null, this.Of = null, this.Nf = !1, this.Ff = !1, this.Wf = !1, this.Hf = null, this.Uf = null, this.$f = null, this.jf = null, this.qf = null, this.Yf = null, this.Kf = null, this.Gf = 0, this.Zf = !1, this.Xf = !1, this.Jf = !1, this.Qf = 0, this.tp = null, this.ip = !wn(), this.np = function (t) { _this.sp(t); }, this.ep = function (t) { if (_this.rp(t)) {
                var i_48 = _this.hp(t);
                if (++_this.Vf, _this.Ef && _this.Vf > 1) {
                    var n_30 = _this.lp(yn(t), _this.Bf).ap;
                    n_30 < 30 && !_this.Wf && _this.op(i_48, _this.up._p), _this.cp();
                }
            }
            else {
                var i_49 = _this.hp(t);
                if (++_this.Rf, _this.Df && _this.Rf > 1) {
                    var n_31 = _this.lp(yn(t), _this.If).ap;
                    n_31 < 5 && !_this.Ff && _this.dp(i_49, _this.up.fp), _this.pp();
                }
            } }, this.vp = t, this.up = i, this.yn = n, this.mp();
        }
        Sn.prototype.m = function () { null !== this.Hf && (this.Hf(), this.Hf = null), null !== this.Uf && (this.Uf(), this.Uf = null), null !== this.jf && (this.jf(), this.jf = null), null !== this.qf && (this.qf(), this.qf = null), null !== this.Yf && (this.Yf(), this.Yf = null), null !== this.$f && (this.$f(), this.$f = null), this.wp(), this.pp(); };
        Sn.prototype.gp = function (t) {
            var _this = this;
            this.jf && this.jf();
            var i = this.Mp.bind(this);
            if (this.jf = function () { _this.vp.removeEventListener("mousemove", i); }, this.vp.addEventListener("mousemove", i), this.rp(t))
                return;
            var n = this.hp(t);
            this.dp(n, this.up.bp), this.ip = !0;
        };
        Sn.prototype.pp = function () { null !== this.Df && clearTimeout(this.Df), this.Rf = 0, this.Df = null, this.If = { _t: Number.NEGATIVE_INFINITY, ut: Number.POSITIVE_INFINITY }; };
        Sn.prototype.cp = function () { null !== this.Ef && clearTimeout(this.Ef), this.Vf = 0, this.Ef = null, this.Bf = { _t: Number.NEGATIVE_INFINITY, ut: Number.POSITIVE_INFINITY }; };
        Sn.prototype.Mp = function (t) { if (this.Jf || null !== this.Of)
            return; if (this.rp(t))
            return; var i = this.hp(t); this.dp(i, this.up.Sp), this.ip = !0; };
        Sn.prototype.xp = function (t) { var i = kn(t.changedTouches, a(this.tp)); if (null === i)
            return; if (this.Qf = Pn(t), null !== this.Kf)
            return; if (this.Xf)
            return; this.Zf = !0; var n = this.lp(yn(i), a(this.Of)), s = n.Cp, e = n.yp, r = n.ap; if (this.Nf || !(r < 5)) {
            if (!this.Nf) {
                var t_49 = .5 * s, i_50 = e >= t_49 && !this.yn.Pp(), n_32 = t_49 > e && !this.yn.kp();
                i_50 || n_32 || (this.Xf = !0), this.Nf = !0, this.Wf = !0, this.wp(), this.cp();
            }
            if (!this.Xf) {
                var n_33 = this.hp(t, i);
                this.op(n_33, this.up.Tp), Cn(t);
            }
        } };
        Sn.prototype.Rp = function (t) { if (0 !== t.button)
            return; var i = this.lp(yn(t), a(this.Lf)), n = i.ap; if (n >= 5 && (this.Ff = !0, this.pp()), this.Ff) {
            var i_51 = this.hp(t);
            this.dp(i_51, this.up.Dp);
        } };
        Sn.prototype.lp = function (t, i) { var n = Math.abs(i._t - t._t), s = Math.abs(i.ut - t.ut); return { Cp: n, yp: s, ap: n + s }; };
        Sn.prototype.Ip = function (t) { var i = kn(t.changedTouches, a(this.tp)); if (null === i && 0 === t.touches.length && (i = t.changedTouches[0]), null === i)
            return; this.tp = null, this.Qf = Pn(t), this.wp(), this.Of = null, this.Yf && (this.Yf(), this.Yf = null); var n = this.hp(t, i); if (this.op(n, this.up.Vp), ++this.Vf, this.Ef && this.Vf > 1) {
            var t_50 = this.lp(yn(i), this.Bf).ap;
            t_50 < 30 && !this.Wf && this.op(n, this.up._p), this.cp();
        }
        else
            this.Wf || (this.op(n, this.up.Ep), this.up.Ep && Cn(t)); 0 === this.Vf && Cn(t), 0 === t.touches.length && this.zf && (this.zf = !1, Cn(t)); };
        Sn.prototype.sp = function (t) { if (0 !== t.button)
            return; var i = this.hp(t); if (this.Lf = null, this.Jf = !1, this.qf && (this.qf(), this.qf = null), mn()) {
            this.vp.ownerDocument.documentElement.removeEventListener("mouseleave", this.np);
        } if (!this.rp(t))
            if (this.dp(i, this.up.Bp), ++this.Rf, this.Df && this.Rf > 1) {
                var n_34 = this.lp(yn(t), this.If).ap;
                n_34 < 5 && !this.Ff && this.dp(i, this.up.fp), this.pp();
            }
            else
                this.Ff || this.dp(i, this.up.Ap); };
        Sn.prototype.wp = function () { null !== this.Af && (clearTimeout(this.Af), this.Af = null); };
        Sn.prototype.zp = function (t) { if (null !== this.tp)
            return; var i = t.changedTouches[0]; this.tp = i.identifier, this.Qf = Pn(t); var n = this.vp.ownerDocument.documentElement; this.Wf = !1, this.Nf = !1, this.Xf = !1, this.Of = yn(i), this.Yf && (this.Yf(), this.Yf = null); {
            var i_52 = this.xp.bind(this), s_16 = this.Ip.bind(this);
            this.Yf = function () { n.removeEventListener("touchmove", i_52), n.removeEventListener("touchend", s_16); }, n.addEventListener("touchmove", i_52, { passive: !1 }), n.addEventListener("touchend", s_16, { passive: !1 }), this.wp(), this.Af = setTimeout(this.Lp.bind(this, t), 240);
        } var s = this.hp(t, i); this.op(s, this.up.Op), this.Ef || (this.Vf = 0, this.Ef = setTimeout(this.cp.bind(this), 500), this.Bf = yn(i)); };
        Sn.prototype.Np = function (t) { if (0 !== t.button)
            return; var i = this.vp.ownerDocument.documentElement; mn() && i.addEventListener("mouseleave", this.np), this.Ff = !1, this.Lf = yn(t), this.qf && (this.qf(), this.qf = null); {
            var t_51 = this.Rp.bind(this), n_35 = this.sp.bind(this);
            this.qf = function () { i.removeEventListener("mousemove", t_51), i.removeEventListener("mouseup", n_35); }, i.addEventListener("mousemove", t_51), i.addEventListener("mouseup", n_35);
        } if (this.Jf = !0, this.rp(t))
            return; var n = this.hp(t); this.dp(n, this.up.Fp), this.Df || (this.Rf = 0, this.Df = setTimeout(this.pp.bind(this), 500), this.If = yn(t)); };
        Sn.prototype.mp = function () {
            var _this = this;
            this.vp.addEventListener("mouseenter", this.gp.bind(this)), this.vp.addEventListener("touchcancel", this.wp.bind(this));
            {
                var t_52 = this.vp.ownerDocument, i_53 = function (t) { _this.up.Wp && (t.composed && _this.vp.contains(t.composedPath()[0]) || t.target && _this.vp.contains(t.target) || _this.up.Wp()); };
                this.Uf = function () { t_52.removeEventListener("touchstart", i_53); }, this.Hf = function () { t_52.removeEventListener("mousedown", i_53); }, t_52.addEventListener("mousedown", i_53), t_52.addEventListener("touchstart", i_53, { passive: !0 });
            }
            wn() && (this.$f = function () { _this.vp.removeEventListener("dblclick", _this.ep); }, this.vp.addEventListener("dblclick", this.ep)), this.vp.addEventListener("mouseleave", this.Hp.bind(this)), this.vp.addEventListener("touchstart", this.zp.bind(this), { passive: !0 }), bn(this.vp), this.vp.addEventListener("mousedown", this.Np.bind(this)), this.Up(), this.vp.addEventListener("touchmove", (function () { }), { passive: !1 });
        };
        Sn.prototype.Up = function () {
            var _this = this;
            void 0 === this.up.$p && void 0 === this.up.jp && void 0 === this.up.qp || (this.vp.addEventListener("touchstart", (function (t) { return _this.Yp(t.touches); }), { passive: !0 }), this.vp.addEventListener("touchmove", (function (t) { if (2 === t.touches.length && null !== _this.Kf && void 0 !== _this.up.jp) {
                var i_54 = xn(t.touches[0], t.touches[1]) / _this.Gf;
                _this.up.jp(_this.Kf, i_54), Cn(t);
            } }), { passive: !1 }), this.vp.addEventListener("touchend", (function (t) { _this.Yp(t.touches); })));
        };
        Sn.prototype.Yp = function (t) { 1 === t.length && (this.Zf = !1), 2 !== t.length || this.Zf || this.zf ? this.Kp() : this.Gp(t); };
        Sn.prototype.Gp = function (t) { var i = this.vp.getBoundingClientRect() || { left: 0, top: 0 }; this.Kf = { _t: (t[0].clientX - i.left + (t[1].clientX - i.left)) / 2, ut: (t[0].clientY - i.top + (t[1].clientY - i.top)) / 2 }, this.Gf = xn(t[0], t[1]), void 0 !== this.up.$p && this.up.$p(), this.wp(); };
        Sn.prototype.Kp = function () { null !== this.Kf && (this.Kf = null, void 0 !== this.up.qp && this.up.qp()); };
        Sn.prototype.Hp = function (t) { if (this.jf && this.jf(), this.rp(t))
            return; if (!this.ip)
            return; var i = this.hp(t); this.dp(i, this.up.Zp), this.ip = !wn(); };
        Sn.prototype.Lp = function (t) { var i = kn(t.touches, a(this.tp)); if (null === i)
            return; var n = this.hp(t, i); this.op(n, this.up.Xp), this.Wf = !0, this.zf = !0; };
        Sn.prototype.rp = function (t) { return t.sourceCapabilities && void 0 !== t.sourceCapabilities.firesTouchEvents ? t.sourceCapabilities.firesTouchEvents : Pn(t) < this.Qf + 500; };
        Sn.prototype.op = function (t, i) { i && i.call(this.up, t); };
        Sn.prototype.dp = function (t, i) { i && i.call(this.up, t); };
        Sn.prototype.hp = function (t, i) { var n = i || t, s = this.vp.getBoundingClientRect() || { left: 0, top: 0 }; return { clientX: n.clientX, clientY: n.clientY, pageX: n.pageX, pageY: n.pageY, screenX: n.screenX, screenY: n.screenY, localX: n.clientX - s.left, localY: n.clientY - s.top, ctrlKey: t.ctrlKey, altKey: t.altKey, shiftKey: t.shiftKey, metaKey: t.metaKey, Jp: !t.type.startsWith("mouse") && "contextmenu" !== t.type && "click" !== t.type, Qp: t.type, tv: n.target, xu: t.view, iv: function () { "touchstart" !== t.type && Cn(t); } }; };
        return Sn;
    }());
    function xn(t, i) { var n = t.clientX - i.clientX, s = t.clientY - i.clientY; return Math.sqrt(n * n + s * s); }
    function Cn(t) { t.cancelable && t.preventDefault(); }
    function yn(t) { return { _t: t.pageX, ut: t.pageY }; }
    function Pn(t) { return t.timeStamp || performance.now(); }
    function kn(t, i) { for (var n_36 = 0; n_36 < t.length; ++n_36)
        if (t[n_36].identifier === i)
            return t[n_36]; return null; }
    var Tn = /** @class */ (function () {
        function Tn(t, i, n) {
            this.nv = null, this.sv = null, this.ev = !0, this.rv = null, this.hv = t, this.av = t.lv()[i], this.ov = t.lv()[n], this._v = document.createElement("tr"), this._v.style.height = "1px", this.uv = document.createElement("td"), this.uv.style.position = "relative", this.uv.style.padding = "0", this.uv.style.margin = "0", this.uv.setAttribute("colspan", "3"), this.cv(), this._v.appendChild(this.uv), this.ev = this.hv.N().layout.panes.enableResize, this.ev ? this.dv() : (this.nv = null, this.sv = null);
        }
        Tn.prototype.m = function () { null !== this.sv && this.sv.m(); };
        Tn.prototype.fv = function () { return this._v; };
        Tn.prototype.pv = function () { return on({ width: this.av.pv().width, height: 1 }); };
        Tn.prototype.vv = function () { return on({ width: this.av.vv().width, height: 1 * window.devicePixelRatio }); };
        Tn.prototype.mv = function (t, i, n) { var s = this.vv(); t.fillStyle = this.hv.N().layout.panes.separatorColor, t.fillRect(i, n, s.width, s.height); };
        Tn.prototype.Pt = function () { this.cv(), this.hv.N().layout.panes.enableResize !== this.ev && (this.ev = this.hv.N().layout.panes.enableResize, this.ev ? this.dv() : (null !== this.nv && (this.uv.removeChild(this.nv.wv), this.uv.removeChild(this.nv.gv), this.nv = null), null !== this.sv && (this.sv.m(), this.sv = null))); };
        Tn.prototype.dv = function () { var t = document.createElement("div"), i = t.style; i.position = "fixed", i.display = "none", i.zIndex = "49", i.top = "0", i.left = "0", i.width = "100%", i.height = "100%", i.cursor = "row-resize", this.uv.appendChild(t); var n = document.createElement("div"), s = n.style; s.position = "absolute", s.zIndex = "50", s.top = "-4px", s.height = "9px", s.width = "100%", s.backgroundColor = "", s.cursor = "row-resize", this.uv.appendChild(n); var e = { bp: this.Mv.bind(this), Zp: this.bv.bind(this), Fp: this.Sv.bind(this), Op: this.Sv.bind(this), Dp: this.xv.bind(this), Tp: this.xv.bind(this), Bp: this.Cv.bind(this), Vp: this.Cv.bind(this) }; this.sv = new Sn(n, e, { Pp: function () { return !1; }, kp: function () { return !0; } }), this.nv = { gv: n, wv: t }; };
        Tn.prototype.cv = function () { this.uv.style.background = this.hv.N().layout.panes.separatorColor; };
        Tn.prototype.Mv = function (t) { null !== this.nv && (this.nv.gv.style.backgroundColor = this.hv.N().layout.panes.separatorHoverColor); };
        Tn.prototype.bv = function (t) { null !== this.nv && null === this.rv && (this.nv.gv.style.backgroundColor = ""); };
        Tn.prototype.Sv = function (t) { if (null === this.nv)
            return; var i = this.av.yv().F_() + this.ov.yv().F_(), n = i / (this.av.pv().height + this.ov.pv().height), s = 30 * n; i <= 2 * s || (this.rv = { Pv: t.pageY, kv: this.av.yv().F_(), Tv: i - s, Rv: i, Dv: n, Iv: s }, this.nv.wv.style.display = "block"); };
        Tn.prototype.xv = function (t) { var i = this.rv; if (null === i)
            return; var n = (t.pageY - i.Pv) * i.Dv, s = Jt(i.kv + n, i.Iv, i.Tv); this.av.yv().W_(s), this.ov.yv().W_(i.Rv - s), this.hv.Qt().ka(); };
        Tn.prototype.Cv = function (t) { null !== this.rv && null !== this.nv && (this.rv = null, this.nv.wv.style.display = "none"); };
        return Tn;
    }());
    function Rn(t, i) { return t.Vv - i.Vv; }
    function Dn(t, i, n) { var s = (t.Vv - i.Vv) / (t.wt - i.wt); return Math.sign(s) * Math.min(Math.abs(s), n); }
    var In = /** @class */ (function () {
        function In(t, i, n, s) {
            this.Ev = null, this.Bv = null, this.Av = null, this.zv = null, this.Lv = null, this.Ov = 0, this.Nv = 0, this.Fv = t, this.Wv = i, this.Hv = n, this.Ps = s;
        }
        In.prototype.Uv = function (t, i) { if (null !== this.Ev) {
            if (this.Ev.wt === i)
                return void (this.Ev.Vv = t);
            if (Math.abs(this.Ev.Vv - t) < this.Ps)
                return;
        } this.zv = this.Av, this.Av = this.Bv, this.Bv = this.Ev, this.Ev = { wt: i, Vv: t }; };
        In.prototype.me = function (t, i) { if (null === this.Ev || null === this.Bv)
            return; if (i - this.Ev.wt > 50)
            return; var n = 0; var s = Dn(this.Ev, this.Bv, this.Wv), e = Rn(this.Ev, this.Bv), r = [s], h = [e]; if (n += e, null !== this.Av) {
            var t_53 = Dn(this.Bv, this.Av, this.Wv);
            if (Math.sign(t_53) === Math.sign(s)) {
                var i_55 = Rn(this.Bv, this.Av);
                if (r.push(t_53), h.push(i_55), n += i_55, null !== this.zv) {
                    var t_54 = Dn(this.Av, this.zv, this.Wv);
                    if (Math.sign(t_54) === Math.sign(s)) {
                        var i_56 = Rn(this.Av, this.zv);
                        r.push(t_54), h.push(i_56), n += i_56;
                    }
                }
            }
        } var a = 0; for (var t_55 = 0; t_55 < r.length; ++t_55)
            a += h[t_55] / n * r[t_55]; Math.abs(a) < this.Fv || (this.Lv = { Vv: t, wt: i }, this.Nv = a, this.Ov = function (t, i) { var n = Math.log(i); return Math.log(1 * n / -t) / n; }(Math.abs(a), this.Hv)); };
        In.prototype.Gc = function (t) { var i = a(this.Lv), n = t - i.wt; return i.Vv + this.Nv * (Math.pow(this.Hv, n) - 1) / Math.log(this.Hv); };
        In.prototype.Kc = function (t) { return null === this.Lv || this.$v(t) === this.Ov; };
        In.prototype.$v = function (t) { var i = t - a(this.Lv).wt; return Math.min(i, this.Ov); };
        return In;
    }());
    var Vn = /** @class */ (function () {
        function Vn(t, i) {
            this.jv = void 0, this.qv = void 0, this.Yv = void 0, this.vn = !1, this.Kv = t, this.Gv = i, this.Zv();
        }
        Vn.prototype.Pt = function () { this.Zv(); };
        Vn.prototype.Xv = function () { this.jv && this.Kv.removeChild(this.jv), this.qv && this.Kv.removeChild(this.qv), this.jv = void 0, this.qv = void 0; };
        Vn.prototype.Jv = function () { return this.vn !== this.Qv() || this.Yv !== this.tm(); };
        Vn.prototype.tm = function () { return this.Gv.Qt().Xi().J(this.Gv.N().layout.textColor) > 160 ? "dark" : "light"; };
        Vn.prototype.Qv = function () { return this.Gv.N().layout.attributionLogo; };
        Vn.prototype.im = function () { var t = new URL(location.href); return t.hostname ? "&utm_source=" + t.hostname + t.pathname : ""; };
        Vn.prototype.Zv = function () { this.Jv() && (this.Xv(), this.vn = this.Qv(), this.vn && (this.Yv = this.tm(), this.qv = document.createElement("style"), this.qv.innerText = "a#tv-attr-logo{--fill:#131722;--stroke:#fff;position:absolute;left:10px;bottom:10px;height:19px;width:35px;margin:0;padding:0;border:0;z-index:3;}a#tv-attr-logo[data-dark]{--fill:#D1D4DC;--stroke:#131722;}", this.jv = document.createElement("a"), this.jv.href = "https://www.tradingview.com/?utm_medium=lwc-link&utm_campaign=lwc-chart".concat(this.im()), this.jv.title = "Charting by TradingView", this.jv.id = "tv-attr-logo", this.jv.target = "_blank", this.jv.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="35" height="19" fill="none"><g fill-rule="evenodd" clip-path="url(#a)" clip-rule="evenodd"><path fill="var(--stroke)" d="M2 0H0v10h6v9h21.4l.5-1.3 6-15 1-2.7H23.7l-.5 1.3-.2.6a5 5 0 0 0-7-.9V0H2Zm20 17h4l5.2-13 .8-2h-7l-1 2.5-.2.5-1.5 3.8-.3.7V17Zm-.8-10a3 3 0 0 0 .7-2.7A3 3 0 1 0 16.8 7h4.4ZM14 7V2H2v6h6v9h4V7h2Z"/><path fill="var(--fill)" d="M14 2H2v6h6v9h6V2Zm12 15h-7l6-15h7l-6 15Zm-7-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/></g><defs><clipPath id="a"><path fill="var(--stroke)" d="M0 0h35v19H0z"/></clipPath></defs></svg>', this.jv.toggleAttribute("data-dark", "dark" === this.Yv), this.Kv.appendChild(this.qv), this.Kv.appendChild(this.jv))); };
        return Vn;
    }());
    function En(t, i) { var n = a(t.ownerDocument).createElement("canvas"); t.appendChild(n); var s = new cn(n, (e = { options: { allowResizeObserver: !0 }, transform: function (t, i) { return ({ width: Math.max(t.width, i.width), height: Math.max(t.height, i.height) }); } }).transform, e.options); var e; return s.resizeCanvasElement(i), s; }
    function Bn(t) { var _j; t.width = 1, t.height = 1, (_j = t.getContext("2d")) === null || _j === void 0 ? void 0 : _j.clearRect(0, 0, 1, 1); }
    function An(t, i, n, s) { t.qh && t.qh(i, n, s); }
    function zn(t, i, n, s) { t.st(i, n, s); }
    function Ln(t, i, n, s) { On(t(n, s), i, s); }
    function On(t, i, n) { for (var _j = 0, t_56 = t; _j < t_56.length; _j++) {
        var s_17 = t_56[_j];
        var t_57 = s_17.Tt(n);
        null !== t_57 && i(t_57);
    } }
    function Nn(t, i) { return function (n) { var _j, _k, _q, _y; if (!function (t) { return void 0 !== t.Ft; }(n))
        return []; return ((_k = (_j = n.Ft()) === null || _j === void 0 ? void 0 : _j.pl()) !== null && _k !== void 0 ? _k : "") !== i ? [] : (_y = (_q = n.Qa) === null || _q === void 0 ? void 0 : _q.call(n, t)) !== null && _y !== void 0 ? _y : []; }; }
    function Fn(t, i, n, s) { if (!t.length)
        return; var e = 0; var r = t[0].$t(s, !0); var h = 1 === i ? n / 2 - (t[0].Hi() - r / 2) : t[0].Hi() - r / 2 - n / 2; h = Math.max(0, h); for (var r_10 = 1; r_10 < t.length; r_10++) {
        var a_10 = t[r_10], l_10 = t[r_10 - 1], o_7 = l_10.$t(s, !1), _6 = a_10.Hi(), u_5 = l_10.Hi();
        if (1 === i ? _6 > u_5 - o_7 : _6 < u_5 + o_7) {
            var s_18 = u_5 - o_7 * i;
            a_10.Ui(s_18);
            var r_11 = s_18 - i * o_7 / 2;
            if ((1 === i ? r_11 < 0 : r_11 > n) && h > 0) {
                var s_19 = 1 === i ? -1 - r_11 : r_11 - n, a_11 = Math.min(s_19, h);
                for (var n_37 = e; n_37 < t.length; n_37++)
                    t[n_37].Ui(t[n_37].Hi() + i * a_11);
                h -= a_11;
            }
        }
        else
            e = r_10, h = 1 === i ? u_5 - o_7 - _6 : _6 - (u_5 + o_7);
    } }
    var Wn = /** @class */ (function () {
        function Wn(t, i, n, s) {
            var _this = this;
            this.Ki = null, this.nm = null, this.sm = !1, this.rm = new it(200), this.hm = null, this.am = 0, this.lm = !1, this.om = function () { _this.lm || _this.yt._m().Qt().mr(); }, this.um = function () { _this.lm || _this.yt._m().Qt().mr(); }, this.yt = t, this.yn = i, this.Ro = i.layout, this.bd = n, this.dm = "left" === s, this.fm = Nn("normal", s), this.pm = Nn("top", s), this.vm = Nn("bottom", s), this.uv = document.createElement("div"), this.uv.style.height = "100%", this.uv.style.overflow = "hidden", this.uv.style.width = "25px", this.uv.style.left = "0", this.uv.style.position = "relative", this.wm = En(this.uv, on({ width: 16, height: 16 })), this.wm.subscribeSuggestedBitmapSizeChanged(this.om);
            var e = this.wm.canvasElement;
            e.style.position = "absolute", e.style.zIndex = "1", e.style.left = "0", e.style.top = "0", this.gm = En(this.uv, on({ width: 16, height: 16 })), this.gm.subscribeSuggestedBitmapSizeChanged(this.um);
            var r = this.gm.canvasElement;
            r.style.position = "absolute", r.style.zIndex = "2", r.style.left = "0", r.style.top = "0";
            var h = { Fp: this.Sv.bind(this), Op: this.Sv.bind(this), Dp: this.xv.bind(this), Tp: this.xv.bind(this), Wp: this.Mm.bind(this), Bp: this.Cv.bind(this), Vp: this.Cv.bind(this), fp: this.bm.bind(this), _p: this.bm.bind(this), bp: this.Sm.bind(this), Zp: this.bv.bind(this) };
            this.sv = new Sn(this.gm.canvasElement, h, { Pp: function () { return !_this.yn.handleScroll.vertTouchDrag; }, kp: function () { return !0; } });
        }
        Wn.prototype.m = function () { this.sv.m(), this.gm.unsubscribeSuggestedBitmapSizeChanged(this.um), Bn(this.gm.canvasElement), this.gm.dispose(), this.wm.unsubscribeSuggestedBitmapSizeChanged(this.om), Bn(this.wm.canvasElement), this.wm.dispose(), null !== this.Ki && this.Ki.__().u(this), this.Ki = null; };
        Wn.prototype.fv = function () { return this.uv; };
        Wn.prototype.P = function () { return this.Ro.fontSize; };
        Wn.prototype.xm = function () { var t = this.bd.N(); return this.hm !== t.k && (this.rm.Os(), this.hm = t.k), t; };
        Wn.prototype.Cm = function () { if (null === this.Ki)
            return 0; var t = 0; var i = this.xm(), n = a(this.wm.canvasElement.getContext("2d", { colorSpace: this.yt._m().N().layout.colorSpace })); n.save(); var s = this.Ki.Ll(); n.font = this.ym(), s.length > 0 && (t = Math.max(this.rm.Ii(n, s[0].eo), this.rm.Ii(n, s[s.length - 1].eo))); var e = this.Pm(); for (var i_57 = e.length; i_57--;) {
            var s_20 = this.rm.Ii(n, e[i_57].ri());
            s_20 > t && (t = s_20);
        } var r = this.Ki.zt(); if (null !== r && null !== this.nm && (2 !== (h = this.yn.crosshair).mode && h.horzLine.visible && h.horzLine.labelVisible)) {
            var i_58 = this.Ki.Tn(1, r), s_21 = this.Ki.Tn(this.nm.height - 2, r);
            t = Math.max(t, this.rm.Ii(n, this.Ki.Ji(Math.floor(Math.min(i_58, s_21)) + .11111111111111, r)), this.rm.Ii(n, this.Ki.Ji(Math.ceil(Math.max(i_58, s_21)) - .11111111111111, r)));
        } var h; n.restore(); var l = t || 34; return Mn(Math.ceil(i.S + i.C + i.V + i.B + 5 + l)); };
        Wn.prototype.km = function (t) { null !== this.nm && _n(this.nm, t) || (this.nm = t, this.lm = !0, this.wm.resizeCanvasElement(t), this.gm.resizeCanvasElement(t), this.lm = !1, this.uv.style.width = "".concat(t.width, "px"), this.uv.style.height = "".concat(t.height, "px")); };
        Wn.prototype.Tm = function () { return a(this.nm).width; };
        Wn.prototype.un = function (t) { this.Ki !== t && (null !== this.Ki && this.Ki.__().u(this), this.Ki = t, t.__().i(this.wo.bind(this), this)); };
        Wn.prototype.Ft = function () { return this.Ki; };
        Wn.prototype.Os = function () { var t = this.yt.yv(); this.yt._m().Qt().au(t, a(this.Ft())); };
        Wn.prototype.Rm = function (t) {
            var _this = this;
            if (null === this.nm)
                return;
            var i = { colorSpace: this.yt._m().N().layout.colorSpace };
            if (1 !== t) {
                this.Dm(), this.wm.applySuggestedBitmapSize();
                var t_58 = pn(this.wm, i);
                null !== t_58 && (t_58.useBitmapCoordinateSpace((function (t) { _this.Im(t), _this.Vm(t); })), this.yt.Em(t_58, this.vm), this.Bm(t_58), this.yt.Em(t_58, this.fm), this.Am(t_58));
            }
            this.gm.applySuggestedBitmapSize();
            var n = pn(this.gm, i);
            null !== n && (n.useBitmapCoordinateSpace((function (_j) {
                var t = _j.context, i = _j.bitmapSize;
                t.clearRect(0, 0, i.width, i.height);
            })), this.zm(n), this.yt.Em(n, this.pm));
        };
        Wn.prototype.vv = function () { return this.wm.bitmapSize; };
        Wn.prototype.mv = function (t, i, n, s) { var e = this.vv(); if (e.width > 0 && e.height > 0 && (t.drawImage(this.wm.canvasElement, i, n), s)) {
            var s_22 = this.gm.canvasElement;
            t.drawImage(s_22, i, n);
        } };
        Wn.prototype.Pt = function () { var _j; (_j = this.Ki) === null || _j === void 0 ? void 0 : _j.Ll(); };
        Wn.prototype.Sv = function (t) { if (null === this.Ki || this.Ki.Zi() || !this.yn.handleScale.axisPressedMouseMove.price)
            return; var i = this.yt._m().Qt(), n = this.yt.yv(); this.sm = !0, i.Q_(n, this.Ki, t.localY); };
        Wn.prototype.xv = function (t) { if (null === this.Ki || !this.yn.handleScale.axisPressedMouseMove.price)
            return; var i = this.yt._m().Qt(), n = this.yt.yv(), s = this.Ki; i.tu(n, s, t.localY); };
        Wn.prototype.Mm = function () { if (null === this.Ki || !this.yn.handleScale.axisPressedMouseMove.price)
            return; var t = this.yt._m().Qt(), i = this.yt.yv(), n = this.Ki; this.sm && (this.sm = !1, t.iu(i, n)); };
        Wn.prototype.Cv = function (t) { if (null === this.Ki || !this.yn.handleScale.axisPressedMouseMove.price)
            return; var i = this.yt._m().Qt(), n = this.yt.yv(); this.sm = !1, i.iu(n, this.Ki); };
        Wn.prototype.bm = function (t) { this.yn.handleScale.axisDoubleClickReset.price && this.Os(); };
        Wn.prototype.Sm = function (t) { if (null === this.Ki)
            return; !this.yt._m().Qt().N().handleScale.axisPressedMouseMove.price || this.Ki.je() || this.Ki.No() || this.Lm(1); };
        Wn.prototype.bv = function (t) { this.Lm(0); };
        Wn.prototype.Pm = function () {
            var _this = this;
            var t = [], i = null === this.Ki ? void 0 : this.Ki;
            return (function (n) { for (var s_23 = 0; s_23 < n.length; ++s_23) {
                var e_12 = n[s_23].qn(_this.yt.yv(), i);
                for (var i_59 = 0; i_59 < e_12.length; i_59++)
                    t.push(e_12[i_59]);
            } })(this.yt.yv().Dt()), t;
        };
        Wn.prototype.Im = function (_j) {
            var t = _j.context, i = _j.bitmapSize;
            var n = i.width, s = i.height, e = this.yt.yv().Qt(), r = e.$(), h = e.af();
            r === h ? E(t, 0, 0, n, s, r) : z(t, 0, 0, n, s, r, h);
        };
        Wn.prototype.Vm = function (_j) {
            var t = _j.context, i = _j.bitmapSize, n = _j.horizontalPixelRatio;
            if (null === this.nm || null === this.Ki || !this.Ki.N().borderVisible)
                return;
            t.fillStyle = this.Ki.N().borderColor;
            var s = Math.max(1, Math.floor(this.xm().S * n));
            var e;
            e = this.dm ? i.width - s : 0, t.fillRect(e, 0, s, i.height);
        };
        Wn.prototype.Bm = function (t) {
            var _this = this;
            if (null === this.nm || null === this.Ki)
                return;
            var i = this.Ki.Ll(), n = this.Ki.N(), s = this.xm(), e = this.dm ? this.nm.width - s.C : 0;
            n.borderVisible && n.ticksVisible && t.useBitmapCoordinateSpace((function (_j) {
                var t = _j.context, r = _j.horizontalPixelRatio, h = _j.verticalPixelRatio;
                t.fillStyle = n.borderColor;
                var a = Math.max(1, Math.floor(h)), l = Math.floor(.5 * h), o = Math.round(s.C * r);
                t.beginPath();
                for (var _k = 0, i_60 = i; _k < i_60.length; _k++) {
                    var n_38 = i_60[_k];
                    t.rect(Math.floor(e * r), Math.round(n_38.Vl * h) - l, o, a);
                }
                t.fill();
            })), t.useMediaCoordinateSpace((function (_j) {
                var _k;
                var t = _j.context;
                t.font = _this.ym(), t.fillStyle = (_k = n.textColor) !== null && _k !== void 0 ? _k : _this.Ro.textColor, t.textAlign = _this.dm ? "right" : "left", t.textBaseline = "middle";
                var r = _this.dm ? Math.round(e - s.V) : Math.round(e + s.C + s.V), h = i.map((function (i) { return _this.rm.Di(t, i.eo); }));
                for (var n_39 = i.length; n_39--;) {
                    var s_24 = i[n_39];
                    t.fillText(s_24.eo, r, s_24.Vl + h[n_39]);
                }
            }));
        };
        Wn.prototype.Dm = function () { if (null === this.nm || null === this.Ki)
            return; var t = this.nm.height / 2; var i = [], n = this.Ki.Dt().slice(), s = this.yt.yv(), e = this.xm(); this.Ki === s.Zs() && this.yt.yv().Dt().forEach((function (t) { s.Gs(t) && n.push(t); })); var r = this.Ki.kl()[0], h = this.Ki; n.forEach((function (n) { var e = n.qn(s, h); e.forEach((function (t) { t.$i() && null === t.Wi() && (t.Ui(null), i.push(t)); })), r === n && e.length > 0 && (t = e[0].Bi()); })); this.Ki.N().alignLabels && this.Om(i, e, t); };
        Wn.prototype.Om = function (t, i, n) { if (null === this.nm)
            return; var s = t.filter((function (t) { return t.Bi() <= n; })), e = t.filter((function (t) { return t.Bi() > n; })); s.sort((function (t, i) { return i.Bi() - t.Bi(); })), s.length && e.length && e.push(s[0]), e.sort((function (t, i) { return t.Bi() - i.Bi(); })); for (var _j = 0, t_59 = t; _j < t_59.length; _j++) {
            var n_40 = t_59[_j];
            var t_60 = Math.floor(n_40.$t(i) / 2), s_25 = n_40.Bi();
            s_25 > -t_60 && s_25 < t_60 && n_40.Ui(t_60), s_25 > this.nm.height - t_60 && s_25 < this.nm.height + t_60 && n_40.Ui(this.nm.height - t_60);
        } Fn(s, 1, this.nm.height, i), Fn(e, -1, this.nm.height, i); };
        Wn.prototype.Am = function (t) {
            var _this = this;
            if (null === this.nm)
                return;
            var i = this.Pm(), n = this.xm(), s = this.dm ? "right" : "left";
            i.forEach((function (i) { if (i.ji()) {
                i.Tt(a(_this.Ki)).st(t, n, _this.rm, s);
            } }));
        };
        Wn.prototype.zm = function (t) {
            var _this = this;
            if (null === this.nm || null === this.Ki)
                return;
            var i = this.yt._m().Qt(), n = [], s = this.yt.yv(), e = i.Vd().qn(s, this.Ki);
            e.length && n.push(e);
            var r = this.xm(), h = this.dm ? "right" : "left";
            n.forEach((function (i) { i.forEach((function (i) { i.Tt(a(_this.Ki)).st(t, r, _this.rm, h); })); }));
        };
        Wn.prototype.Lm = function (t) { this.uv.style.cursor = 1 === t ? "ns-resize" : "default"; };
        Wn.prototype.wo = function () { var t = this.Cm(); this.am < t && this.yt._m().Qt().ka(), this.am = t; };
        Wn.prototype.ym = function () { return g(this.Ro.fontSize, this.Ro.fontFamily); };
        return Wn;
    }());
    function Hn(t, i) { var _j, _k; return (_k = (_j = t.Xa) === null || _j === void 0 ? void 0 : _j.call(t, i)) !== null && _k !== void 0 ? _k : []; }
    function Un(t, i) { var _j, _k; return (_k = (_j = t.jn) === null || _j === void 0 ? void 0 : _j.call(t, i)) !== null && _k !== void 0 ? _k : []; }
    function $n(t, i) { var _j, _k; return (_k = (_j = t.cn) === null || _j === void 0 ? void 0 : _j.call(t, i)) !== null && _k !== void 0 ? _k : []; }
    function jn(t, i) { var _j, _k; return (_k = (_j = t.qa) === null || _j === void 0 ? void 0 : _j.call(t, i)) !== null && _k !== void 0 ? _k : []; }
    var qn = /** @class */ (function () {
        function qn(t, i) {
            var _this = this;
            this.nm = on({ width: 0, height: 0 }), this.Nm = null, this.Fm = null, this.Wm = null, this.Hm = null, this.Um = !1, this.$m = new o, this.jm = new o, this.qm = 0, this.Ym = !1, this.Km = null, this.Gm = !1, this.Zm = null, this.Xm = null, this.lm = !1, this.om = function () { _this.lm || null === _this.Jm || _this.sn().mr(); }, this.um = function () { _this.lm || null === _this.Jm || _this.sn().mr(); }, this.Gv = t, this.Jm = i, this.Jm.mu().i(this.Qm.bind(this), this, !0), this.tw = document.createElement("td"), this.tw.style.padding = "0", this.tw.style.position = "relative";
            var n = document.createElement("div");
            n.style.width = "100%", n.style.height = "100%", n.style.position = "relative", n.style.overflow = "hidden", this.iw = document.createElement("td"), this.iw.style.padding = "0", this.nw = document.createElement("td"), this.nw.style.padding = "0", this.tw.appendChild(n), this.wm = En(n, on({ width: 16, height: 16 })), this.wm.subscribeSuggestedBitmapSizeChanged(this.om);
            var s = this.wm.canvasElement;
            s.style.position = "absolute", s.style.zIndex = "1", s.style.left = "0", s.style.top = "0", this.gm = En(n, on({ width: 16, height: 16 })), this.gm.subscribeSuggestedBitmapSizeChanged(this.um);
            var e = this.gm.canvasElement;
            e.style.position = "absolute", e.style.zIndex = "2", e.style.left = "0", e.style.top = "0", this._v = document.createElement("tr"), this._v.appendChild(this.iw), this._v.appendChild(this.tw), this._v.appendChild(this.nw), this.sw(), this.sv = new Sn(this.gm.canvasElement, this, { Pp: function () { return null === _this.Km && !_this.Gv.N().handleScroll.vertTouchDrag; }, kp: function () { return null === _this.Km && !_this.Gv.N().handleScroll.horzTouchDrag; } });
        }
        qn.prototype.m = function () { null !== this.Nm && this.Nm.m(), null !== this.Fm && this.Fm.m(), this.Wm = null, this.gm.unsubscribeSuggestedBitmapSizeChanged(this.um), Bn(this.gm.canvasElement), this.gm.dispose(), this.wm.unsubscribeSuggestedBitmapSizeChanged(this.om), Bn(this.wm.canvasElement), this.wm.dispose(), null !== this.Jm && (this.Jm.mu().u(this), this.Jm.m()), this.sv.m(); };
        qn.prototype.yv = function () { return a(this.Jm); };
        qn.prototype.ew = function (t) { var _j, _k; null !== this.Jm && this.Jm.mu().u(this), this.Jm = t, null !== this.Jm && this.Jm.mu().i(qn.prototype.Qm.bind(this), this, !0), this.sw(), this.Gv.lv().indexOf(this) === this.Gv.lv().length - 1 ? (this.Wm = (_j = this.Wm) !== null && _j !== void 0 ? _j : new Vn(this.tw, this.Gv), this.Wm.Pt()) : ((_k = this.Wm) === null || _k === void 0 ? void 0 : _k.Xv(), this.Wm = null); };
        qn.prototype._m = function () { return this.Gv; };
        qn.prototype.fv = function () { return this._v; };
        qn.prototype.sw = function () { if (null !== this.Jm && (this.rw(), 0 !== this.sn().Jn().length)) {
            if (null !== this.Nm) {
                var t_61 = this.Jm.X_();
                this.Nm.un(a(t_61));
            }
            if (null !== this.Fm) {
                var t_62 = this.Jm.J_();
                this.Fm.un(a(t_62));
            }
        } };
        qn.prototype.hw = function () { null !== this.Nm && this.Nm.Pt(), null !== this.Fm && this.Fm.Pt(); };
        qn.prototype.F_ = function () { return null !== this.Jm ? this.Jm.F_() : 0; };
        qn.prototype.W_ = function (t) { this.Jm && this.Jm.W_(t); };
        qn.prototype.bp = function (t) { if (!this.Jm)
            return; this.aw(); var i = t.localX, n = t.localY; this.lw(i, n, t); };
        qn.prototype.Fp = function (t) { this.aw(), this.ow(), this.lw(t.localX, t.localY, t); };
        qn.prototype.Sp = function (t) { if (!this.Jm)
            return; this.aw(); var i = t.localX, n = t.localY; this.lw(i, n, t); };
        qn.prototype.Ap = function (t) { null !== this.Jm && (this.aw(), this.lw(t.localX, t.localY, t), this._w(t)); };
        qn.prototype.fp = function (t) { null !== this.Jm && this.uw(this.jm, t); };
        qn.prototype._p = function (t) { this.fp(t); };
        qn.prototype.Dp = function (t) { this.aw(), this.cw(t), this.lw(t.localX, t.localY, t); };
        qn.prototype.Bp = function (t) { null !== this.Jm && (this.aw(), this.Ym = !1, this.dw(t)); };
        qn.prototype.Ep = function (t) { null !== this.Jm && this._w(t); };
        qn.prototype.Xp = function (t) { if (this.Ym = !0, null === this.Km) {
            var i_61 = { x: t.localX, y: t.localY };
            this.fw(i_61, i_61, t);
        } };
        qn.prototype.Zp = function (t) { null !== this.Jm && (this.aw(), this.Jm.Qt().Rd(null), this.pw()); };
        qn.prototype.mw = function () { return this.$m; };
        qn.prototype.ww = function () { return this.jm; };
        qn.prototype.$p = function () { this.qm = 1, this.sn().cs(); };
        qn.prototype.jp = function (t, i) { if (!this.Gv.N().handleScale.pinch)
            return; var n = 5 * (i - this.qm); this.qm = i, this.sn().Wd(t._t, n); };
        qn.prototype.Op = function (t) { this.Ym = !1, this.Gm = null !== this.Km, this.ow(); var i = this.sn().Vd(); null !== this.Km && i.It() && (this.Zm = { x: i.ni(), y: i.si() }, this.Km = { x: t.localX, y: t.localY }); };
        qn.prototype.Tp = function (t) { if (null === this.Jm)
            return; var i = t.localX, n = t.localY; if (null === this.Km)
            this.cw(t);
        else {
            this.Gm = !1;
            var s_26 = a(this.Zm), e_13 = s_26.x + (i - this.Km.x), r_12 = s_26.y + (n - this.Km.y);
            this.lw(e_13, r_12, t);
        } };
        qn.prototype.Vp = function (t) { 0 === this._m().N().trackingMode.exitMode && (this.Gm = !0), this.gw(), this.dw(t); };
        qn.prototype.Qs = function (t, i) { var n = this.Jm; return null === n ? null : Ri(n, t, i); };
        qn.prototype.Mw = function (t, i) { a("left" === i ? this.Nm : this.Fm).km(on({ width: t, height: this.nm.height })); };
        qn.prototype.pv = function () { return this.nm; };
        qn.prototype.km = function (t) { _n(this.nm, t) || (this.nm = t, this.lm = !0, this.wm.resizeCanvasElement(t), this.gm.resizeCanvasElement(t), this.lm = !1, this.tw.style.width = t.width + "px", this.tw.style.height = t.height + "px"); };
        qn.prototype.bw = function () { var t = a(this.Jm); t.G_(t.X_()), t.G_(t.J_()); for (var _j = 0, _k = t.kl(); _j < _k.length; _j++) {
            var i_62 = _k[_j];
            if (t.Gs(i_62)) {
                var n_41 = i_62.Ft();
                null !== n_41 && t.G_(n_41), i_62.Nn();
            }
        } for (var _q = 0, _y = t.gu(); _q < _y.length; _q++) {
            var i_63 = _y[_q];
            i_63.Nn();
        } };
        qn.prototype.vv = function () { return this.wm.bitmapSize; };
        qn.prototype.mv = function (t, i, n, s) { var e = this.vv(); if (e.width > 0 && e.height > 0 && (t.drawImage(this.wm.canvasElement, i, n), s)) {
            var s_27 = this.gm.canvasElement;
            null !== t && t.drawImage(s_27, i, n);
        } };
        qn.prototype.Rm = function (t) {
            var _this = this;
            if (0 === t)
                return;
            if (null === this.Jm)
                return;
            t > 1 && this.bw(), null !== this.Nm && this.Nm.Rm(t), null !== this.Fm && this.Fm.Rm(t);
            var i = { colorSpace: this.Gv.N().layout.colorSpace };
            if (1 !== t) {
                this.wm.applySuggestedBitmapSize();
                var t_63 = pn(this.wm, i);
                null !== t_63 && (t_63.useBitmapCoordinateSpace((function (t) { _this.Im(t); })), this.Jm && (this.Sw(t_63, Hn), this.xw(t_63), this.Sw(t_63, Un), this.Sw(t_63, $n)));
            }
            this.gm.applySuggestedBitmapSize();
            var n = pn(this.gm, i);
            null !== n && (n.useBitmapCoordinateSpace((function (_j) {
                var t = _j.context, i = _j.bitmapSize;
                t.clearRect(0, 0, i.width, i.height);
            })), this.Cw(n), this.Sw(n, jn), this.Sw(n, $n));
        };
        qn.prototype.yw = function () { return this.Nm; };
        qn.prototype.Pw = function () { return this.Fm; };
        qn.prototype.Em = function (t, i) { this.Sw(t, i); };
        qn.prototype.Qm = function () { null !== this.Jm && this.Jm.mu().u(this), this.Jm = null; };
        qn.prototype._w = function (t) { this.uw(this.$m, t); };
        qn.prototype.uw = function (t, i) { var n = i.localX, s = i.localY; t.v() && t.p(this.sn().Bt().Vc(n), { x: n, y: s }, i); };
        qn.prototype.Im = function (_j) {
            var t = _j.context, i = _j.bitmapSize;
            var n = i.width, s = i.height, e = this.sn(), r = e.$(), h = e.af();
            r === h ? E(t, 0, 0, n, s, h) : z(t, 0, 0, n, s, r, h);
        };
        qn.prototype.xw = function (t) { var i = a(this.Jm), n = i.wu().wr().Tt(i); null !== n && n.st(t, !1); };
        qn.prototype.Cw = function (t) { this.kw(t, Un, zn, this.sn().Vd()); };
        qn.prototype.Sw = function (t, i) { var n = a(this.Jm), s = i === Un ? this.Tw() : null, e = null === s ? null : this.Rw(s, n), r = n.gu(); if (null === e || null === s) {
            var s_28 = n._u();
            return this.Dw(t, i, An, r, s_28), void this.Dw(t, i, zn, r, s_28);
        } var h = n.Dt(), l = function (t) { return t === s ? e.Za : void 0; }; this.Dw(t, i, An, r, h, l), this.Dw(t, i, zn, r, h, l), this.kw(t, i, An, s, e.qa), this.kw(t, i, zn, s, e.qa); };
        qn.prototype.Dw = function (t, i, n, s, e, r) { for (var _j = 0, s_29 = s; _j < s_29.length; _j++) {
            var e_16 = s_29[_j];
            this.kw(t, i, n, e_16);
        } if (void 0 !== r)
            for (var _k = 0, e_14 = e; _k < e_14.length; _k++) {
                var s_30 = e_14[_k];
                this.kw(t, i, n, s_30, r(s_30));
            }
        else
            for (var _q = 0, e_15 = e; _q < e_15.length; _q++) {
                var s_31 = e_15[_q];
                this.kw(t, i, n, s_31);
            } };
        qn.prototype.Tw = function () { var _j; var t = a(this.Jm), i = (_j = t.Qt().cu()) === null || _j === void 0 ? void 0 : _j.uu; if (!t.Qt().N().hoveredSeriesOnTop || void 0 === i)
            return null; for (var _k = 0, _q = t.Dt(); _k < _q.length; _k++) {
            var n_42 = _q[_k];
            if (n_42 === i)
                return n_42;
        } return null; };
        qn.prototype.Rw = function (t, i) { var _j, _k; var n = (_k = (_j = t.Ga) === null || _j === void 0 ? void 0 : _j.call(t, i)) !== null && _k !== void 0 ? _k : null; return null === n || 0 === n.qa.length ? null : n; };
        qn.prototype.kw = function (t, i, n, s, e) { var r = a(this.Jm), h = r.Qt().cu(), l = null !== h && h.uu === s, o = null !== h && l && void 0 !== h.bu ? h.bu.ie : void 0, _ = function (i) { return n(i, t, l, o); }; void 0 === e ? Ln(i, _, s, r) : On(e, _, r); };
        qn.prototype.rw = function () { if (null === this.Jm)
            return; var t = this.Gv, i = this.Jm.X_().N().visible, n = this.Jm.J_().N().visible; i || null === this.Nm || (this.iw.removeChild(this.Nm.fv()), this.Nm.m(), this.Nm = null), n || null === this.Fm || (this.nw.removeChild(this.Fm.fv()), this.Fm.m(), this.Fm = null); var s = t.Qt().Jd(); i && null === this.Nm && (this.Nm = new Wn(this, t.N(), s, "left"), this.iw.appendChild(this.Nm.fv())), n && null === this.Fm && (this.Fm = new Wn(this, t.N(), s, "right"), this.nw.appendChild(this.Fm.fv())); };
        qn.prototype.Iw = function (t) { return t.Jp && this.Ym || null !== this.Km; };
        qn.prototype.lw = function (t, i, n) { t = Math.max(0, Math.min(t, this.nm.width - 1)), i = Math.max(0, Math.min(i, this.nm.height - 1)), this.sn().Kd(t, i, n, a(this.Jm)); };
        qn.prototype.pw = function () { this.sn().Zd(); };
        qn.prototype.gw = function () { this.Gm && (this.Km = null, this.pw()); };
        qn.prototype.fw = function (t, i, n) { this.Km = t, this.Gm = !1, this.lw(i.x, i.y, n); var s = this.sn().Vd(); this.Zm = { x: s.ni(), y: s.si() }; };
        qn.prototype.sn = function () { return this.Gv.Qt(); };
        qn.prototype.dw = function (t) { if (!this.Um)
            return; var i = this.sn(), n = this.yv(); if (i.eu(n, n.kn()), this.Hm = null, this.Um = !1, i.jd(), null !== this.Xm) {
            var t_64 = performance.now(), n_43 = i.Bt();
            this.Xm.me(n_43.Oc(), t_64), this.Xm.Kc(t_64) || i.ps(this.Xm);
        } };
        qn.prototype.aw = function () { this.Km = null; };
        qn.prototype.ow = function () { if (!this.Jm)
            return; if (this.sn().cs(), document.activeElement !== document.body && document.activeElement !== document.documentElement)
            a(document.activeElement).blur();
        else {
            var t_65 = document.getSelection();
            null !== t_65 && t_65.removeAllRanges();
        } !this.Jm.kn().Zi() && this.sn().Bt().Zi(); };
        qn.prototype.cw = function (t) { if (null === this.Jm)
            return; var i = this.sn(), n = i.Bt(); if (n.Zi())
            return; var s = this.Gv.N(), e = s.handleScroll, r = s.kineticScroll; if ((!e.pressedMouseMove || t.Jp) && (!e.horzTouchDrag && !e.vertTouchDrag || !t.Jp))
            return; var h = this.Jm.kn(), a = performance.now(); if (null !== this.Hm || this.Iw(t) || (this.Hm = { x: t.clientX, y: t.clientY, yf: a, Vw: t.localX, Ew: t.localY }), null !== this.Hm && !this.Um && (this.Hm.x !== t.clientX || this.Hm.y !== t.clientY)) {
            if (t.Jp && r.touch || !t.Jp && r.mouse) {
                var t_66 = n.ml();
                this.Xm = new In(.2 / t_66, 7 / t_66, .997, 15 / t_66), this.Xm.Uv(n.Oc(), this.Hm.yf);
            }
            else
                this.Xm = null;
            h.Zi() || i.nu(this.Jm, h, t.localY), i.Ud(t.localX), this.Um = !0;
        } this.Um && (h.Zi() || i.su(this.Jm, h, t.localY), i.$d(t.localX), null !== this.Xm && this.Xm.Uv(n.Oc(), a)); };
        return qn;
    }());
    var Yn = /** @class */ (function () {
        function Yn(t, i, n, s, e) {
            var _this = this;
            this.xt = !0, this.nm = on({ width: 0, height: 0 }), this.om = function () { return _this.Rm(3); }, this.dm = "left" === t, this.bd = n.Jd, this.yn = i, this.Bw = s, this.Aw = e, this.uv = document.createElement("div"), this.uv.style.width = "25px", this.uv.style.height = "100%", this.uv.style.overflow = "hidden", this.wm = En(this.uv, on({ width: 16, height: 16 })), this.wm.subscribeSuggestedBitmapSizeChanged(this.om);
        }
        Yn.prototype.m = function () { this.wm.unsubscribeSuggestedBitmapSizeChanged(this.om), Bn(this.wm.canvasElement), this.wm.dispose(); };
        Yn.prototype.fv = function () { return this.uv; };
        Yn.prototype.pv = function () { return this.nm; };
        Yn.prototype.km = function (t) { _n(this.nm, t) || (this.nm = t, this.wm.resizeCanvasElement(t), this.uv.style.width = "".concat(t.width, "px"), this.uv.style.height = "".concat(t.height, "px"), this.xt = !0); };
        Yn.prototype.Rm = function (t) {
            var _this = this;
            if (t < 3 && !this.xt)
                return;
            if (0 === this.nm.width || 0 === this.nm.height)
                return;
            this.xt = !1, this.wm.applySuggestedBitmapSize();
            var i = pn(this.wm, { colorSpace: this.yn.layout.colorSpace });
            null !== i && i.useBitmapCoordinateSpace((function (t) { _this.Im(t), _this.Vm(t); }));
        };
        Yn.prototype.vv = function () { return this.wm.bitmapSize; };
        Yn.prototype.mv = function (t, i, n) { var s = this.vv(); s.width > 0 && s.height > 0 && t.drawImage(this.wm.canvasElement, i, n); };
        Yn.prototype.Vm = function (_j) {
            var t = _j.context, i = _j.bitmapSize, n = _j.horizontalPixelRatio, s = _j.verticalPixelRatio;
            if (!this.Bw())
                return;
            t.fillStyle = this.yn.timeScale.borderColor;
            var e = Math.floor(this.bd.N().S * n), r = Math.floor(this.bd.N().S * s), h = this.dm ? i.width - e : 0;
            t.fillRect(h, 0, e, r);
        };
        Yn.prototype.Im = function (_j) {
            var t = _j.context, i = _j.bitmapSize;
            E(t, 0, 0, i.width, i.height, this.Aw());
        };
        return Yn;
    }());
    function Kn(t) { return function (i) { var _j, _k; return (_k = (_j = i.tl) === null || _j === void 0 ? void 0 : _j.call(i, t)) !== null && _k !== void 0 ? _k : []; }; }
    var Gn = Kn("normal"), Zn = Kn("top"), Xn = Kn("bottom");
    var Jn = /** @class */ (function () {
        function Jn(t, i) {
            var _this = this;
            this.zw = null, this.Lw = null, this.M = null, this.Ow = !1, this.nm = on({ width: 0, height: 0 }), this.Nw = new o, this.rm = new it(5), this.lm = !1, this.om = function () { _this.lm || _this.Gv.Qt().mr(); }, this.um = function () { _this.lm || _this.Gv.Qt().mr(); }, this.Gv = t, this.Pu = i, this.yn = t.N().layout, this.jv = document.createElement("tr"), this.Fw = document.createElement("td"), this.Fw.style.padding = "0", this.Ww = document.createElement("td"), this.Ww.style.padding = "0", this.uv = document.createElement("td"), this.uv.style.height = "25px", this.uv.style.padding = "0", this.Hw = document.createElement("div"), this.Hw.style.width = "100%", this.Hw.style.height = "100%", this.Hw.style.position = "relative", this.Hw.style.overflow = "hidden", this.uv.appendChild(this.Hw), this.wm = En(this.Hw, on({ width: 16, height: 16 })), this.wm.subscribeSuggestedBitmapSizeChanged(this.om);
            var n = this.wm.canvasElement;
            n.style.position = "absolute", n.style.zIndex = "1", n.style.left = "0", n.style.top = "0", this.gm = En(this.Hw, on({ width: 16, height: 16 })), this.gm.subscribeSuggestedBitmapSizeChanged(this.um);
            var s = this.gm.canvasElement;
            s.style.position = "absolute", s.style.zIndex = "2", s.style.left = "0", s.style.top = "0", this.jv.appendChild(this.Fw), this.jv.appendChild(this.uv), this.jv.appendChild(this.Ww), this.Uw(), this.Gv.Qt().N_().i(this.Uw.bind(this), this), this.sv = new Sn(this.gm.canvasElement, this, { Pp: function () { return !0; }, kp: function () { return !_this.Gv.N().handleScroll.horzTouchDrag; } });
        }
        Jn.prototype.m = function () { this.sv.m(), null !== this.zw && this.zw.m(), null !== this.Lw && this.Lw.m(), this.gm.unsubscribeSuggestedBitmapSizeChanged(this.um), Bn(this.gm.canvasElement), this.gm.dispose(), this.wm.unsubscribeSuggestedBitmapSizeChanged(this.om), Bn(this.wm.canvasElement), this.wm.dispose(); };
        Jn.prototype.fv = function () { return this.jv; };
        Jn.prototype.$w = function () { return this.zw; };
        Jn.prototype.jw = function () { return this.Lw; };
        Jn.prototype.Fp = function (t) { if (this.Ow)
            return; this.Ow = !0; var i = this.Gv.Qt(); !i.Bt().Zi() && this.Gv.N().handleScale.axisPressedMouseMove.time && i.Fd(t.localX); };
        Jn.prototype.Op = function (t) { this.Fp(t); };
        Jn.prototype.Wp = function () { var t = this.Gv.Qt(); !t.Bt().Zi() && this.Ow && (this.Ow = !1, this.Gv.N().handleScale.axisPressedMouseMove.time && t.Yd()); };
        Jn.prototype.Dp = function (t) { var i = this.Gv.Qt(); !i.Bt().Zi() && this.Gv.N().handleScale.axisPressedMouseMove.time && i.qd(t.localX); };
        Jn.prototype.Tp = function (t) { this.Dp(t); };
        Jn.prototype.Bp = function () { this.Ow = !1; var t = this.Gv.Qt(); t.Bt().Zi() && !this.Gv.N().handleScale.axisPressedMouseMove.time || t.Yd(); };
        Jn.prototype.Vp = function () { this.Bp(); };
        Jn.prototype.fp = function () { this.Gv.N().handleScale.axisDoubleClickReset.time && this.Gv.Qt().ws(); };
        Jn.prototype._p = function () { this.fp(); };
        Jn.prototype.bp = function () { this.Gv.Qt().N().handleScale.axisPressedMouseMove.time && this.Lm(1); };
        Jn.prototype.Zp = function () { this.Lm(0); };
        Jn.prototype.pv = function () { return this.nm; };
        Jn.prototype.qw = function () { return this.Nw; };
        Jn.prototype.Yw = function (t, i, n) { _n(this.nm, t) || (this.nm = t, this.lm = !0, this.wm.resizeCanvasElement(t), this.gm.resizeCanvasElement(t), this.lm = !1, this.uv.style.width = "".concat(t.width, "px"), this.uv.style.height = "".concat(t.height, "px"), this.Nw.p(t)), null !== this.zw && this.zw.km(on({ width: i, height: t.height })), null !== this.Lw && this.Lw.km(on({ width: n, height: t.height })); };
        Jn.prototype.Kw = function () { var t = this.Gw(); return Math.ceil(t.S + t.C + t.P + t.A + t.I + t.Zw); };
        Jn.prototype.Pt = function () { this.Gv.Qt().Bt().Ll(); };
        Jn.prototype.vv = function () { return this.wm.bitmapSize; };
        Jn.prototype.mv = function (t, i, n, s) { var e = this.vv(); if (e.width > 0 && e.height > 0 && (t.drawImage(this.wm.canvasElement, i, n), s)) {
            var s_32 = this.gm.canvasElement;
            t.drawImage(s_32, i, n);
        } };
        Jn.prototype.Rm = function (t) {
            var _this = this;
            if (0 === t)
                return;
            var i = { colorSpace: this.yn.colorSpace };
            if (1 !== t) {
                this.wm.applySuggestedBitmapSize();
                var n_44 = pn(this.wm, i);
                null !== n_44 && (n_44.useBitmapCoordinateSpace((function (t) { _this.Im(t), _this.Vm(t), _this.Xw(n_44, Xn); })), this.Bm(n_44), this.Xw(n_44, Gn)), null !== this.zw && this.zw.Rm(t), null !== this.Lw && this.Lw.Rm(t);
            }
            this.gm.applySuggestedBitmapSize();
            var n = pn(this.gm, i);
            null !== n && (n.useBitmapCoordinateSpace((function (_j) {
                var t = _j.context, i = _j.bitmapSize;
                t.clearRect(0, 0, i.width, i.height);
            })), this.Jw(__spreadArray(__spreadArray([], this.Gv.Qt().Jn(), true), [this.Gv.Qt().Vd()], false), n), this.Xw(n, Zn));
        };
        Jn.prototype.Xw = function (t, i) { var n = this.Gv.Qt().Jn(); for (var _j = 0, n_45 = n; _j < n_45.length; _j++) {
            var s_33 = n_45[_j];
            Ln(i, (function (i) { return An(i, t, !1, void 0); }), s_33, void 0);
        } for (var _k = 0, n_46 = n; _k < n_46.length; _k++) {
            var s_34 = n_46[_k];
            Ln(i, (function (i) { return zn(i, t, !1, void 0); }), s_34, void 0);
        } };
        Jn.prototype.Im = function (_j) {
            var t = _j.context, i = _j.bitmapSize;
            E(t, 0, 0, i.width, i.height, this.Gv.Qt().af());
        };
        Jn.prototype.Vm = function (_j) {
            var t = _j.context, i = _j.bitmapSize, n = _j.verticalPixelRatio;
            if (this.Gv.N().timeScale.borderVisible) {
                t.fillStyle = this.Qw();
                var s_35 = Math.max(1, Math.floor(this.Gw().S * n));
                t.fillRect(0, 0, i.width, s_35);
            }
        };
        Jn.prototype.Bm = function (t) {
            var _this = this;
            var i = this.Gv.Qt().Bt(), n = i.Ll();
            if (!n || 0 === n.length)
                return;
            var s = this.Pu.maxTickMarkWeight(n), e = this.Gw(), r = i.N();
            r.borderVisible && r.ticksVisible && t.useBitmapCoordinateSpace((function (_j) {
                var t = _j.context, i = _j.horizontalPixelRatio, s = _j.verticalPixelRatio;
                t.strokeStyle = _this.Qw(), t.fillStyle = _this.Qw();
                var r = Math.max(1, Math.floor(i)), h = Math.floor(.5 * i);
                t.beginPath();
                var a = Math.round(e.C * s);
                for (var s_36 = n.length; s_36--;) {
                    var e_17 = Math.round(n[s_36].coord * i);
                    t.rect(e_17 - h, 0, r, a);
                }
                t.fill();
            })), t.useMediaCoordinateSpace((function (_j) {
                var t = _j.context;
                var i = e.S + e.C + e.A + e.P / 2;
                t.textAlign = "center", t.textBaseline = "middle", t.fillStyle = _this.H(), t.font = _this.ym();
                for (var _k = 0, n_47 = n; _k < n_47.length; _k++) {
                    var e_18 = n_47[_k];
                    if (e_18.weight < s) {
                        var n_49 = e_18.needAlignCoordinate ? _this.tg(t, e_18.coord, e_18.label) : e_18.coord;
                        t.fillText(e_18.label, n_49, i);
                    }
                }
                _this.Gv.N().timeScale.allowBoldLabels && (t.font = _this.ig());
                for (var _q = 0, n_48 = n; _q < n_48.length; _q++) {
                    var e_19 = n_48[_q];
                    if (e_19.weight >= s) {
                        var n_50 = e_19.needAlignCoordinate ? _this.tg(t, e_19.coord, e_19.label) : e_19.coord;
                        t.fillText(e_19.label, n_50, i);
                    }
                }
            }));
        };
        Jn.prototype.tg = function (t, i, n) { var s = this.rm.Ii(t, n), e = s / 2, r = Math.floor(i - e) + .5; return r < 0 ? i += Math.abs(0 - r) : r + s > this.nm.width && (i -= Math.abs(this.nm.width - (r + s))), i; };
        Jn.prototype.Jw = function (t, i) { var n = this.Gw(); for (var _j = 0, t_67 = t; _j < t_67.length; _j++) {
            var s_37 = t_67[_j];
            for (var _k = 0, _q = s_37.dn(); _k < _q.length; _k++) {
                var t_68 = _q[_k];
                t_68.Tt().st(i, n);
            }
        } };
        Jn.prototype.Qw = function () { return this.Gv.N().timeScale.borderColor; };
        Jn.prototype.H = function () { return this.yn.textColor; };
        Jn.prototype.F = function () { return this.yn.fontSize; };
        Jn.prototype.ym = function () { return g(this.F(), this.yn.fontFamily); };
        Jn.prototype.ig = function () { return g(this.F(), this.yn.fontFamily, "bold"); };
        Jn.prototype.Gw = function () { null === this.M && (this.M = { S: 1, L: NaN, A: NaN, I: NaN, tn: NaN, C: 5, P: NaN, k: "", Qi: new it, Zw: 0 }); var t = this.M, i = this.ym(); if (t.k !== i) {
            var n_51 = this.F();
            t.P = n_51, t.k = i, t.A = 3 * n_51 / 12, t.I = 3 * n_51 / 12, t.tn = 9 * n_51 / 12, t.L = 0, t.Zw = 4 * n_51 / 12, t.Qi.Os();
        } return this.M; };
        Jn.prototype.Lm = function (t) { this.uv.style.cursor = 1 === t ? "ew-resize" : "default"; };
        Jn.prototype.Uw = function () { var t = this.Gv.Qt(), i = t.N(); i.leftPriceScale.visible || null === this.zw || (this.Fw.removeChild(this.zw.fv()), this.zw.m(), this.zw = null), i.rightPriceScale.visible || null === this.Lw || (this.Ww.removeChild(this.Lw.fv()), this.Lw.m(), this.Lw = null); var n = { Jd: this.Gv.Qt().Jd() }, s = function () { return i.leftPriceScale.borderVisible && t.Bt().N().borderVisible; }, e = function () { return t.af(); }; i.leftPriceScale.visible && null === this.zw && (this.zw = new Yn("left", i, n, s, e), this.Fw.appendChild(this.zw.fv())), i.rightPriceScale.visible && null === this.Lw && (this.Lw = new Yn("right", i, n, s, e), this.Ww.appendChild(this.Lw.fv())); };
        return Jn;
    }());
    var Qn = !!vn && !!navigator.userAgentData && navigator.userAgentData.brands.some((function (t) { return t.brand.includes("Chromium"); })) && !!vn && (((_j = navigator === null || navigator === void 0 ? void 0 : navigator.userAgentData) === null || _j === void 0 ? void 0 : _j.platform) ? "Windows" === navigator.userAgentData.platform : navigator.userAgent.toLowerCase().indexOf("win") >= 0);
    var ts = /** @class */ (function () {
        function ts(t, i, n) {
            var s;
            this.ng = [], this.sg = [], this.eg = 0, this.oo = 0, this.k_ = 0, this.rg = 0, this.hg = 0, this.ag = null, this.lg = !1, this.$m = new o, this.jm = new o, this.wd = new o, this.og = null, this._g = null, this.Kv = t, this.yn = i, this.Pu = n, this.jv = document.createElement("div"), this.jv.classList.add("tv-lightweight-charts"), this.jv.style.overflow = "hidden", this.jv.style.direction = "ltr", this.jv.style.width = "100%", this.jv.style.height = "100%", (s = this.jv).style.userSelect = "none", s.style.webkitUserSelect = "none", s.style.msUserSelect = "none", s.style.MozUserSelect = "none", s.style.webkitTapHighlightColor = "transparent", this.ug = document.createElement("table"), this.ug.setAttribute("cellspacing", "0"), this.jv.appendChild(this.ug), this.cg = this.dg.bind(this), is(this.yn) && this.fg(!0), this.sn = new Hi(this.Md.bind(this), this.yn, n), this.Qt().Ed().i(this.pg.bind(this), this), this.vg = new Jn(this, this.Pu), this.ug.appendChild(this.vg.fv());
            var e = i.autoSize && this.mg();
            var r = this.yn.width, h = this.yn.height;
            if (e || 0 === r || 0 === h) {
                var i_64 = t.getBoundingClientRect();
                r = r || i_64.width, h = h || i_64.height;
            }
            this.wg(r, h), this.gg(), t.appendChild(this.jv), this.Mg(), this.sn.Bt().Jc().i(this.sn.ka.bind(this.sn), this), this.sn.N_().i(this.sn.ka.bind(this.sn), this);
        }
        ts.prototype.Qt = function () { return this.sn; };
        ts.prototype.N = function () { return this.yn; };
        ts.prototype.lv = function () { return this.ng; };
        ts.prototype.bg = function () { return this.vg; };
        ts.prototype.m = function () { this.fg(!1), 0 !== this.eg && window.cancelAnimationFrame(this.eg), this.sn.Ed().u(this), this.sn.Bt().Jc().u(this), this.sn.N_().u(this), this.sn.m(); for (var _j = 0, _k = this.ng; _j < _k.length; _j++) {
            var t_69 = _k[_j];
            this.ug.removeChild(t_69.fv()), t_69.mw().u(this), t_69.ww().u(this), t_69.m();
        } this.ng = []; for (var _q = 0, _y = this.sg; _q < _y.length; _q++) {
            var t_70 = _y[_q];
            this.Sg(t_70);
        } this.sg = [], a(this.vg).m(), null !== this.jv.parentElement && this.jv.parentElement.removeChild(this.jv), this.wd.m(), this.$m.m(), this.jm.m(), this.xg(); };
        ts.prototype.wg = function (t, i, n) {
            if (n === void 0) { n = !1; }
            if (this.oo === i && this.k_ === t)
                return;
            var s = function (t) { var i = Math.floor(t.width), n = Math.floor(t.height); return on({ width: i - i % 2, height: n - n % 2 }); }(on({ width: t, height: i }));
            this.oo = s.height, this.k_ = s.width;
            var e = this.oo + "px", r = this.k_ + "px";
            if (this.Cg() || (a(this.jv).style.height = e, a(this.jv).style.width = r), this.ug.style.height = e, this.ug.style.width = r, n) {
                0 !== this.eg && (window.cancelAnimationFrame(this.eg), this.eg = 0), this.lg = !1;
                var t_71 = Y.ys();
                null !== this.ag && (t_71.Ss(this.ag), this.ag = null), this.yg(t_71, performance.now());
            }
            else
                this.sn.ka();
        };
        ts.prototype.Rm = function (t) { void 0 === t && (t = Y.ys()); for (var i_65 = 0; i_65 < this.ng.length; i_65++)
            this.ng[i_65].Rm(t._s(i_65).rs); this.yn.timeScale.visible && this.vg.Rm(t.ls()); };
        ts.prototype.vr = function (t) { var _j; var i = is(this.yn); this.sn.vr(t); var n = is(this.yn); n !== i && this.fg(n), ((_j = t.layout) === null || _j === void 0 ? void 0 : _j.panes) && this.Pg(), this.Mg(), this.kg(t); };
        ts.prototype.mw = function () { return this.$m; };
        ts.prototype.ww = function () { return this.jm; };
        ts.prototype.Ed = function () { return this.wd; };
        ts.prototype.Tg = function (t) {
            if (t === void 0) { t = !1; }
            null !== this.ag && (this.yg(this.ag, performance.now()), this.ag = null);
            var i = this.Rg(null), n = document.createElement("canvas");
            n.width = i.width, n.height = i.height;
            var s = a(n.getContext("2d"));
            return this.Rg(s, t), n;
        };
        ts.prototype.Dg = function (t) { if ("left" === t && !this.Ig())
            return 0; if ("right" === t && !this.Vg())
            return 0; if (0 === this.ng.length)
            return 0; return a("left" === t ? this.ng[0].yw() : this.ng[0].Pw()).Tm(); };
        ts.prototype.Cg = function () { return this.yn.autoSize && null !== this.og; };
        ts.prototype.gv = function () { return this.jv; };
        ts.prototype.Eg = function (t) { this._g = t, this._g ? this.gv().style.setProperty("cursor", t) : this.gv().style.removeProperty("cursor"); };
        ts.prototype.Bg = function () { return this._g; };
        ts.prototype.Ag = function (t) { return h(this.ng[t]).pv(); };
        ts.prototype.Pg = function () { this.sg.forEach((function (t) { t.Pt(); })); };
        ts.prototype.kg = function (t) { (void 0 !== t.autoSize || !this.og || void 0 === t.width && void 0 === t.height) && (t.autoSize && !this.og && this.mg(), !1 === t.autoSize && null !== this.og && this.xg(), t.autoSize || void 0 === t.width && void 0 === t.height || this.wg(t.width || this.k_, t.height || this.oo)); };
        ts.prototype.Rg = function (t, i) {
            var _this = this;
            var n = 0, s = 0;
            var e = this.ng[0], r = function (n, s) { var e = 0; for (var r_13 = 0; r_13 < _this.ng.length; r_13++) {
                var h_8 = _this.ng[r_13], l_11 = a("left" === n ? h_8.yw() : h_8.Pw()), o_8 = l_11.vv();
                if (null !== t && l_11.mv(t, s, e, i), e += o_8.height, r_13 < _this.ng.length - 1) {
                    var i_66 = _this.sg[r_13], n_52 = i_66.vv();
                    null !== t && i_66.mv(t, s, e), e += n_52.height;
                }
            } };
            if (this.Ig()) {
                r("left", 0);
                n += a(e.yw()).vv().width;
            }
            for (var e_20 = 0; e_20 < this.ng.length; e_20++) {
                var r_14 = this.ng[e_20], h_9 = r_14.vv();
                if (null !== t && r_14.mv(t, n, s, i), s += h_9.height, e_20 < this.ng.length - 1) {
                    var i_67 = this.sg[e_20], r_15 = i_67.vv();
                    null !== t && i_67.mv(t, n, s), s += r_15.height;
                }
            }
            if (n += e.vv().width, this.Vg()) {
                r("right", n);
                n += a(e.Pw()).vv().width;
            }
            var h = function (i, n, s) { a("left" === i ? _this.vg.$w() : _this.vg.jw()).mv(a(t), n, s); };
            if (this.yn.timeScale.visible) {
                var n_53 = this.vg.vv();
                if (null !== t) {
                    var r_16 = 0;
                    this.Ig() && (h("left", r_16, s), r_16 = a(e.yw()).vv().width), this.vg.mv(t, r_16, s, i), r_16 += n_53.width, this.Vg() && h("right", r_16, s);
                }
                s += n_53.height;
            }
            return on({ width: n, height: s });
        };
        ts.prototype.zg = function () { var t = 0, i = 0, n = 0; for (var _j = 0, _k = this.ng; _j < _k.length; _j++) {
            var s_38 = _k[_j];
            this.Ig() && (i = Math.max(i, a(s_38.yw()).Cm(), this.yn.leftPriceScale.minimumWidth)), this.Vg() && (n = Math.max(n, a(s_38.Pw()).Cm(), this.yn.rightPriceScale.minimumWidth)), t += s_38.F_();
        } i = Mn(i), n = Mn(n); var s = this.k_, e = this.oo, r = Math.max(s - i - n, 0), h = 1 * this.sg.length, l = this.yn.timeScale.visible; var o = l ? Math.max(this.vg.Kw(), this.yn.timeScale.minimumHeight) : 0; var _; o = (_ = o) + _ % 2; var u = h + o, c = e < u ? 0 : e - u, d = c / t; var f = 0; var p = window.devicePixelRatio || 1; for (var t_72 = 0; t_72 < this.ng.length; ++t_72) {
            var s_39 = this.ng[t_72];
            s_39.ew(this.sn.Gn()[t_72]);
            var e_21 = 0, h_10 = 0;
            h_10 = t_72 === this.ng.length - 1 ? Math.ceil((c - f) * p) / p : Math.round(s_39.F_() * d * p) / p, e_21 = Math.max(h_10, 2), f += e_21, s_39.km(on({ width: r, height: e_21 })), this.Ig() && s_39.Mw(i, "left"), this.Vg() && s_39.Mw(n, "right"), s_39.yv() && this.sn.Bd(s_39.yv(), e_21);
        } this.vg.Yw(on({ width: l ? r : 0, height: o }), l ? i : 0, l ? n : 0), this.sn.H_(r), this.rg !== i && (this.rg = i), this.hg !== n && (this.hg = n); };
        ts.prototype.fg = function (t) { t ? this.jv.addEventListener("wheel", this.cg, { passive: !1 }) : this.jv.removeEventListener("wheel", this.cg); };
        ts.prototype.Lg = function (t) { switch (t.deltaMode) {
            case t.DOM_DELTA_PAGE: return 120;
            case t.DOM_DELTA_LINE: return 32;
        } return Qn ? 1 / window.devicePixelRatio : 1; };
        ts.prototype.dg = function (t) { if (!(0 !== t.deltaX && this.yn.handleScroll.mouseWheel || 0 !== t.deltaY && this.yn.handleScale.mouseWheel))
            return; var i = this.Lg(t), n = i * t.deltaX / 100, s = -i * t.deltaY / 100; if (t.cancelable && t.preventDefault(), 0 !== s && this.yn.handleScale.mouseWheel) {
            var i_68 = Math.sign(s) * Math.min(1, Math.abs(s)), n_54 = t.clientX - this.jv.getBoundingClientRect().left;
            this.Qt().Wd(n_54, i_68);
        } 0 !== n && this.yn.handleScroll.mouseWheel && this.Qt().Hd(-80 * n); };
        ts.prototype.yg = function (t, i) { var _j; var n = t.ls(); 3 === n && this.Og(), 3 !== n && 2 !== n || (this.Ng(t), this.Fg(t, i), this.vg.Pt(), this.ng.forEach((function (t) { t.hw(); })), 3 === ((_j = this.ag) === null || _j === void 0 ? void 0 : _j.ls()) && (this.ag.Ss(t), this.Og(), this.Ng(this.ag), this.Fg(this.ag, i), t = this.ag, this.ag = null)), this.Rm(t); };
        ts.prototype.Fg = function (t, i) { for (var _j = 0, _k = t.bs(); _j < _k.length; _j++) {
            var n_55 = _k[_j];
            this.xs(n_55, i);
        } };
        ts.prototype.Ng = function (t) { var i = this.sn.Gn(); for (var n_56 = 0; n_56 < i.length; n_56++)
            t._s(n_56).hs && i[n_56].lu(); };
        ts.prototype.xs = function (t, i) { var n = this.sn.Bt(); switch (t.ds) {
            case 0:
                n.td();
                break;
            case 1:
                n.nd(t.Wt);
                break;
            case 2:
                n.gs(t.Wt);
                break;
            case 3:
                n.Ms(t.Wt);
                break;
            case 4:
                n.Wc();
                break;
            case 5: t.Wt.Kc(i) || n.Ms(t.Wt.Gc(i));
        } };
        ts.prototype.Md = function (t) {
            var _this = this;
            null !== this.ag ? this.ag.Ss(t) : this.ag = t, this.lg || (this.lg = !0, this.eg = window.requestAnimationFrame((function (t) { if (_this.lg = !1, _this.eg = 0, null !== _this.ag) {
                var i_69 = _this.ag;
                _this.ag = null, _this.yg(i_69, t);
                for (var _j = 0, _k = i_69.bs(); _j < _k.length; _j++) {
                    var n_57 = _k[_j];
                    if (5 === n_57.ds && !n_57.Wt.Kc(t)) {
                        _this.Qt().ps(n_57.Wt);
                        break;
                    }
                }
            } })));
        };
        ts.prototype.Og = function () { this.gg(); };
        ts.prototype.Sg = function (t) { this.ug.removeChild(t.fv()), t.m(); };
        ts.prototype.gg = function () { var t = this.sn.Gn(), i = t.length, n = this.ng.length; for (var t_73 = i; t_73 < n; t_73++) {
            var t_74 = h(this.ng.pop());
            this.ug.removeChild(t_74.fv()), t_74.mw().u(this), t_74.ww().u(this), t_74.m();
            var i_70 = this.sg.pop();
            void 0 !== i_70 && this.Sg(i_70);
        } for (var s_40 = n; s_40 < i; s_40++) {
            var i_71 = new qn(this, t[s_40]);
            if (i_71.mw().i(this.Wg.bind(this, i_71), this), i_71.ww().i(this.Hg.bind(this, i_71), this), this.ng.push(i_71), s_40 > 0) {
                var t_75 = new Tn(this, s_40 - 1, s_40);
                this.sg.push(t_75), this.ug.insertBefore(t_75.fv(), this.vg.fv());
            }
            this.ug.insertBefore(i_71.fv(), this.vg.fv());
        } for (var n_58 = 0; n_58 < i; n_58++) {
            var i_72 = t[n_58], s_41 = this.ng[n_58];
            s_41.yv() !== i_72 ? s_41.ew(i_72) : s_41.sw();
        } this.Mg(), this.zg(); };
        ts.prototype.Ug = function (t, i, n, s) { var _j; var e = new Map; if (null !== t) {
            this.sn.Jn().forEach((function (i) { var n = i.Un().Hn(t); null !== n && e.set(i, n); }));
        } var r; if (null !== t) {
            var i_73 = (_j = this.sn.Bt().en(t)) === null || _j === void 0 ? void 0 : _j.originalTime;
            void 0 !== i_73 && (r = i_73);
        } var h = this.Qt().cu(), a = this.$g(s), l = function (t, i) { var _j; var n = null !== t && t.uu instanceof Kt ? t.uu : void 0, s = (_j = t === null || t === void 0 ? void 0 : t.bu) === null || _j === void 0 ? void 0 : _j.te, e = void 0 !== i && -1 !== i ? i : void 0; return null === t || void 0 === t.ee ? { jg: n, qg: s } : { jg: n, qg: s, Yg: { ds: t.ee, Kg: (r = t.uu, h = t.ee, r instanceof Si ? "pane-primitive" : "marker" === h || "primitive" === h ? "series-primitive" : "series"), Gg: gn(t.ee, s), Y_: n, Zg: s, Xg: e } }; var r, h; }(h, a); return { Qr: r, $n: t !== null && t !== void 0 ? t : void 0, Jg: i !== null && i !== void 0 ? i : void 0, Xg: -1 !== a ? a : void 0, jg: l.jg, Qg: e, qg: l.qg, Yg: l.Yg, tM: n !== null && n !== void 0 ? n : void 0 }; };
        ts.prototype.$g = function (t) { var i = -1; if (t)
            i = this.ng.indexOf(t);
        else {
            var t_76 = this.Qt().Vd().Kn();
            null !== t_76 && (i = this.Qt().Gn().indexOf(t_76));
        } return i; };
        ts.prototype.Wg = function (t, i, n, s) {
            var _this = this;
            this.$m.p((function () { return _this.Ug(i, n, s, t); }));
        };
        ts.prototype.Hg = function (t, i, n, s) {
            var _this = this;
            this.jm.p((function () { return _this.Ug(i, n, s, t); }));
        };
        ts.prototype.pg = function (t, i, n) {
            var _this = this;
            var _j, _k;
            this.Eg((_k = (_j = this.Qt().cu()) === null || _j === void 0 ? void 0 : _j.Mu) !== null && _k !== void 0 ? _k : null), this.wd.p((function () { return _this.Ug(t, i, n); }));
        };
        ts.prototype.Mg = function () { var t = this.yn.timeScale.visible ? "" : "none"; this.vg.fv().style.display = t; };
        ts.prototype.Ig = function () { return this.ng[0].yv().X_().N().visible; };
        ts.prototype.Vg = function () { return this.ng[0].yv().J_().N().visible; };
        ts.prototype.mg = function () {
            var _this = this;
            return "ResizeObserver" in window && (this.og = new ResizeObserver((function (t) { var i = t[t.length - 1]; if (!i)
                return; var n = i.contentRect.width, s = i.contentRect.height; _this.wg(n, s, !0); })), this.og.observe(this.Kv, { box: "border-box" }), !0);
        };
        ts.prototype.xg = function () { null !== this.og && this.og.disconnect(), this.og = null; };
        return ts;
    }());
    function is(t) { return Boolean(t.handleScroll.mouseWheel || t.handleScale.mouseWheel); }
    function ns(t) { return void 0 === t.open && void 0 === t.value; }
    function ss(t) { return function (t) { return void 0 !== t.open; }(t) || function (t) { return void 0 !== t.value; }(t); }
    function es(t, i, n, s) { var e = n.value, r = { $n: i, wt: t, Wt: [e, e, e, e], Qr: s }; return void 0 !== n.color && (r.R = n.color), r; }
    function rs(t, i, n, s) { var e = n.value, r = { $n: i, wt: t, Wt: [e, e, e, e], Qr: s }; return void 0 !== n.lineColor && (r.vt = n.lineColor), void 0 !== n.topColor && (r.ah = n.topColor), void 0 !== n.bottomColor && (r.oh = n.bottomColor), r; }
    function hs(t, i, n, s) { var e = n.value, r = { $n: i, wt: t, Wt: [e, e, e, e], Qr: s }; return void 0 !== n.topLineColor && (r._h = n.topLineColor), void 0 !== n.bottomLineColor && (r.uh = n.bottomLineColor), void 0 !== n.topFillColor1 && (r.dh = n.topFillColor1), void 0 !== n.topFillColor2 && (r.fh = n.topFillColor2), void 0 !== n.bottomFillColor1 && (r.ph = n.bottomFillColor1), void 0 !== n.bottomFillColor2 && (r.mh = n.bottomFillColor2), r; }
    function as(t, i, n, s) { var e = { $n: i, wt: t, Wt: [n.open, n.high, n.low, n.close], Qr: s }; return void 0 !== n.color && (e.R = n.color), e; }
    function ls(t, i, n, s) { var e = { $n: i, wt: t, Wt: [n.open, n.high, n.low, n.close], Qr: s }; return void 0 !== n.color && (e.R = n.color), void 0 !== n.borderColor && (e.Ht = n.borderColor), void 0 !== n.wickColor && (e.hh = n.wickColor), e; }
    function os(t, i, n, s, e) { var r = h(e)(n), a = Math.max.apply(Math, r), l = Math.min.apply(Math, r), o = r[r.length - 1], _ = [o, a, l, o], u = n.time, c = n.color, d = __rest(n, ["time", "color"]); return { $n: i, wt: t, Wt: _, Qr: s, ue: d, R: c }; }
    function _s(t) { return void 0 !== t.Wt; }
    function us(t, i) { return void 0 !== i.customValues && (t.iM = i.customValues), t; }
    function cs(t) { return function (i, n, s, e, r, h) { return function (t, i) { return i ? i(t) : ns(t); }(s, h) ? us({ wt: i, $n: n, Qr: e }, s) : us(t(i, n, s, e, r), s); }; }
    function ds(t) { return { Candlestick: cs(ls), Bar: cs(as), Area: cs(rs), Baseline: cs(hs), Histogram: cs(es), Line: cs(es), Custom: cs(os) }[t]; }
    function fs(t) { return { $n: 0, nM: new Map, Oa: t }; }
    function ps(t, i) { if (void 0 !== t && 0 !== t.length)
        return { sM: i.key(t[0].wt), eM: i.key(t[t.length - 1].wt) }; }
    function vs(t) { var i; return t.forEach((function (t) { void 0 === i && (i = t.Qr); })), h(i); }
    var ms = /** @class */ (function () {
        function ms(t) {
            this.rM = new Map, this.hM = new Map, this.aM = new Map, this.lM = [], this.Pu = t;
        }
        ms.prototype.m = function () { this.rM.clear(), this.hM.clear(), this.aM.clear(), this.lM = []; };
        ms.prototype.oM = function (t, i) {
            var _this = this;
            var n = 0 !== this.rM.size, s = !1;
            var e = this.hM.get(t);
            if (void 0 !== e)
                if (1 === this.hM.size)
                    n = !1, s = !0, this.rM.clear();
                else
                    for (var _j = 0, _k = this.lM; _j < _k.length; _j++) {
                        var i_74 = _k[_j];
                        i_74.pointData.nM.delete(t) && (s = !0);
                    }
            var r = [];
            if (0 !== i.length) {
                var n_59 = i.map((function (t) { return t.time; })), e_22 = this.Pu.createConverterToInternalObj(i), h_11 = ds(t.bh()), a_12 = t.ul(), l_12 = t.cl();
                r = i.map((function (i, r) { var o = e_22(i.time), _ = _this.Pu.key(o); var u = _this.rM.get(_); void 0 === u && (u = fs(o), _this.rM.set(_, u), s = !0); var c = h_11(o, u.$n, i, n_59[r], a_12, l_12); return u.nM.set(t, c), c; }));
            }
            n && this._M(), this.uM(t, r);
            var h = -1;
            if (s) {
                var t_77 = [];
                this.rM.forEach((function (i) { t_77.push({ timeWeight: 0, time: i.Oa, pointData: i, originalTime: vs(i.nM) }); })), t_77.sort((function (t, i) { return _this.Pu.key(t.time) - _this.Pu.key(i.time); })), h = this.cM(t_77);
            }
            return this.dM(t, h, function (t, i, n) { var s = ps(t, n), e = ps(i, n); if (void 0 !== s && void 0 !== e)
                return { fM: !1, Va: s.eM >= e.eM && s.sM >= e.sM }; }(this.hM.get(t), e, this.Pu));
        };
        ms.prototype.if = function (t) { return this.oM(t, []); };
        ms.prototype.pM = function (t, i, n) {
            var _this = this;
            if (n && t.Fa())
                throw new Error("Historical updates are not supported when conflation is enabled. Conflation requires data to be processed in order.");
            var s = i;
            !function (t) { void 0 === t.Qr && (t.Qr = t.time); }(s), this.Pu.preprocessData(i);
            var e = this.Pu.createConverterToInternalObj([i])(i.time), r = this.aM.get(t);
            if (!n && void 0 !== r && this.Pu.key(e) < this.Pu.key(r))
                throw new Error("Cannot update oldest data, last time=".concat(r, ", new time=").concat(e));
            var h = this.rM.get(this.Pu.key(e));
            if (n && void 0 === h)
                throw new Error("Cannot update non-existing data point when historicalUpdate is true");
            var a = void 0 === h;
            void 0 === h && (h = fs(e), this.rM.set(this.Pu.key(e), h));
            var l = ds(t.bh()), o = t.ul(), _ = t.cl(), u = l(e, h.$n, i, s.Qr, o, _), c = !n && !a && void 0 !== r && this.Pu.key(e) === this.Pu.key(r);
            h.nM.set(t, u), n ? this.vM(t, u, h.$n) : c && t.Fa() && _s(u) ? (t.Rr(u), this.mM(t, u)) : this.mM(t, u);
            var d = { Va: _s(u), fM: n };
            if (!a)
                return this.dM(t, -1, d);
            var f = { timeWeight: 0, time: h.Oa, pointData: h, originalTime: vs(h.nM) }, p = yt(this.lM, this.Pu.key(f.time), (function (t, i) { return _this.Pu.key(t.time) < i; }));
            this.lM.splice(p, 0, f);
            for (var t_78 = p; t_78 < this.lM.length; ++t_78)
                ws(this.lM[t_78].pointData, t_78);
            return this.Pu.fillWeightsForPoints(this.lM, p), this.dM(t, p, d);
        };
        ms.prototype.wM = function (t, i) { var n = this.hM.get(t); if (void 0 === n || i <= 0)
            return [[], this.gM()]; i = Math.min(i, n.length); var s = n.splice(-i).reverse(); 0 === n.length ? this.aM.delete(t) : this.aM.set(t, n[n.length - 1].wt); for (var _j = 0, s_42 = s; _j < s_42.length; _j++) {
            var i_75 = s_42[_j];
            var n_60 = this.rM.get(this.Pu.key(i_75.wt));
            if (n_60 && (n_60.nM.delete(t), 0 === n_60.nM.size)) {
                this.rM.delete(this.Pu.key(n_60.Oa)), this.lM.splice(n_60.$n, 1);
                for (var t_79 = n_60.$n; t_79 < this.lM.length; ++t_79)
                    ws(this.lM[t_79].pointData, t_79);
            }
        } return [s, this.dM(t, this.lM.length - 1, { fM: !1, Va: !1 })]; };
        ms.prototype.mM = function (t, i) { var n = this.hM.get(t); void 0 === n && (n = [], this.hM.set(t, n)); var s = 0 !== n.length ? n[n.length - 1] : null; null === s || this.Pu.key(i.wt) > this.Pu.key(s.wt) ? _s(i) && n.push(i) : _s(i) ? n[n.length - 1] = i : n.splice(-1, 1), this.aM.set(t, i.wt); };
        ms.prototype.vM = function (t, i, n) { var s = this.hM.get(t); if (void 0 === s)
            return; var e = yt(s, n, (function (t, i) { return t.$n < i; })); _s(i) ? s[e] = i : s.splice(e, 1); };
        ms.prototype.uM = function (t, i) { 0 !== i.length ? (this.hM.set(t, i.filter(_s)), this.aM.set(t, i[i.length - 1].wt)) : (this.hM.delete(t), this.aM.delete(t)); };
        ms.prototype._M = function () { for (var _j = 0, _k = this.lM; _j < _k.length; _j++) {
            var t_80 = _k[_j];
            0 === t_80.pointData.nM.size && this.rM.delete(this.Pu.key(t_80.time));
        } };
        ms.prototype.cM = function (t) { var i = -1; for (var n_61 = 0; n_61 < this.lM.length && n_61 < t.length; ++n_61) {
            var s_43 = this.lM[n_61], e_23 = t[n_61];
            if (this.Pu.key(s_43.time) !== this.Pu.key(e_23.time)) {
                i = n_61;
                break;
            }
            e_23.timeWeight = s_43.timeWeight, ws(e_23.pointData, n_61);
        } if (-1 === i && this.lM.length !== t.length && (i = Math.min(this.lM.length, t.length)), -1 === i)
            return -1; for (var n_62 = i; n_62 < t.length; ++n_62)
            ws(t[n_62].pointData, n_62); return this.Pu.fillWeightsForPoints(t, i), this.lM = t, i; };
        ms.prototype.MM = function () { if (0 === this.hM.size)
            return null; var t = 0; return this.hM.forEach((function (i) { 0 !== i.length && (t = Math.max(t, i[i.length - 1].$n)); })), t; };
        ms.prototype.dM = function (t, i, n) { var s = this.gM(); if (-1 !== i)
            this.hM.forEach((function (i, e) { s.Y_.set(e, { ue: i, bM: e === t ? n : void 0 }); })), this.hM.has(t) || s.Y_.set(t, { ue: [], bM: n }), s.Bt.SM = this.lM, s.Bt.xM = i;
        else {
            var i_76 = this.hM.get(t);
            s.Y_.set(t, { ue: i_76 || [], bM: n });
        } return s; };
        ms.prototype.gM = function () { return { Y_: new Map, Bt: { Dc: this.MM() } }; };
        return ms;
    }());
    function ws(t, i) { t.$n = i, t.nM.forEach((function (t) { t.$n = i; })); }
    function gs(t, i) { return t._t < i; }
    function Ms(t, i) { return i < t._t; }
    function bs(t, i, n, s) { return yt(t, i, gs, n, s); }
    function Ss(t, i, n, s) { return Pt(t, i, Ms, n, s); }
    function xs(t, i, n) { return { ne: t, se: i, ee: n }; }
    function Cs(t, i, n, s) { return t >= i - s && t <= n + s; }
    function ys(t, i, n, s, e, r) { var h = e - n, a = r - s; if (0 === h && 0 === a)
        return Math.hypot(t - n, i - s); var l = ((t - n) * h + (i - s) * a) / (h * h + a * a), o = Math.max(0, Math.min(1, l)), _ = n + h * o, u = s + a * o; return Math.hypot(t - _, i - u); }
    var Ps = [0, 0];
    function ks(t, i, n) { return void 0 === i || i.wt !== t.wt - 1 ? t._t - n / 2 : (i._t + t._t) / 2; }
    function Ts(t, i, n) { return void 0 === i || i.wt !== t.wt + 1 ? t._t + n / 2 : (t._t + i._t) / 2; }
    function Rs(t, i, n, s, e, r, h) { if (null === i || i.from >= i.to || 0 === t.length)
        return null; var a = e / 2 + r, l = bs(t, n - a, i.from, i.to), o = Ss(t, n + a, l, i.to); if (l >= o)
        return null; var _ = Number.POSITIVE_INFINITY; for (var a_13 = l; a_13 < o; a_13++) {
        var l_13 = t[a_13], o_9 = a_13 > i.from ? t[a_13 - 1] : void 0, u_6 = a_13 < i.to - 1 ? t[a_13 + 1] : void 0, c_3 = ks(l_13, o_9, e) - r, d_1 = Ts(l_13, u_6, e) + r;
        if (n < c_3 || n > d_1)
            continue;
        h(l_13, Ps);
        var f_2 = Ps[0], p_1 = Ps[1], v_1 = Math.min(f_2, p_1), m_1 = Math.max(f_2, p_1), w_1 = v_1 - r, g_1 = m_1 + r;
        if (s >= v_1 && s <= m_1)
            _ = Math.min(_, 0);
        else if (s >= w_1 && s <= g_1) {
            var t_81 = Math.min(Math.abs(s - v_1), Math.abs(m_1 - s));
            _ = Math.min(_, t_81);
        }
    } return Number.isFinite(_) ? xs(_, 0, "series-range") : null; }
    function Ds(t, i) { return t.wt < i; }
    function Is(t, i) { return i < t.wt; }
    function Vs(t, i, n) { var s = i.Na(), e = i.bi(), r = yt(t, s, Ds), h = Pt(t, e, Is); if (!n)
        return { from: r, to: h }; var a = r, l = h; return r > 0 && r < t.length && t[r].wt >= s && (a = r - 1), h > 0 && h < t.length && t[h - 1].wt <= e && (l = h + 1), { from: a, to: l }; }
    var Es = /** @class */ (function () {
        function Es(t, i, n) {
            this.CM = !0, this.yM = !0, this.PM = !0, this.kM = [], this.TM = null, this.RM = -1, this.ae = t, this.le = i, this.DM = n;
        }
        Es.prototype.Pt = function (t) { this.CM = !0, "data" === t && (this.yM = !0), "options" === t && (this.PM = !0); };
        Es.prototype.Tt = function () { return this.ae.It() ? (this.IM(), null === this.TM ? null : this.VM) : null; };
        Es.prototype.Qs = function (t, i) { return this.ae.It() ? (this.IM(), null === this.TM ? null : this.EM(t, i)) : null; };
        Es.prototype.EM = function (t, i) { return null; };
        Es.prototype.BM = function () {
            var _this = this;
            this.kM = this.kM.map((function (t) { return (__assign(__assign({}, t), _this.ae.Sa().Sh(t.wt))); }));
        };
        Es.prototype.AM = function () { this.TM = null; };
        Es.prototype.IM = function () { var t = this.le.Bt(), i = t.N().enableConflation ? t.sd() : 0; i !== this.RM && (this.yM = !0, this.RM = i), this.yM && (this.zM(), this.yM = !1), this.PM && (this.BM(), this.PM = !1), this.CM && (this.LM(), this.CM = !1); };
        Es.prototype.LM = function () { var t = this.ae.Ft(), i = this.le.Bt(); if (this.AM(), i.Zi() || t.Zi())
            return; var n = i.Be(); if (null === n)
            return; if (0 === this.ae.Un().Th())
            return; var s = this.ae.zt(); null !== s && (this.TM = Vs(this.kM, n, this.DM), this.OM(t, i, s.Wt), this.NM()); };
        return Es;
    }());
    var Bs = /** @class */ (function () {
        function Bs(t, i) {
            this.FM = t, this.Ki = i;
        }
        Bs.prototype.st = function (t, i, n) { this.FM.draw(t, this.Ki, i, n); };
        return Bs;
    }());
    function As(t) { switch (t) {
        case "point": return 2;
        case "range": return 0;
        default: return 1;
    } }
    var zs = /** @class */ (function (_super) {
        __extends(zs, _super);
        function zs(t, i, n) {
            var _this = this;
            _this = _super.call(this, t, i, !1) || this, _this.Yh = n, _this.FM = _this.Yh.renderer(), _this.VM = new Bs(_this.FM, (function (t) { return _this.WM(t); }));
            return _this;
        }
        Object.defineProperty(zs.prototype, "Ma", {
            get: function () { return this.Yh.conflationReducer; },
            enumerable: false,
            configurable: true
        });
        zs.prototype.Ha = function (t) { return this.Yh.priceValueBuilder(t); };
        zs.prototype.dl = function (t) { return this.Yh.isWhitespace(t); };
        zs.prototype.EM = function (t, i) {
            var _this = this;
            var _j, _k;
            var n = (_k = (_j = this.FM).hitTest) === null || _k === void 0 ? void 0 : _k.call(_j, t, i, (function (t) { return _this.WM(t); }));
            if (null != n)
                return { ne: (s = n).distance, se: As(s.type), ee: "custom", Mu: s.cursorStyle, te: s.objectId, ie: s.hitTestData };
            var s;
            var e = Rs(this.kM, this.TM, t, i, this.le.Bt().ml(), this.ae.N().hitTestTolerance, (function (t, i) { var n = t.HM; var s = NaN, e = NaN; if (void 0 !== n && !_this.Yh.isWhitespace(n))
                for (var _j = 0, _k = _this.Yh.priceValueBuilder(n); _j < _k.length; _j++) {
                    var t_82 = _k[_j];
                    var i_77 = _this.WM(t_82);
                    null !== i_77 && (s = Number.isNaN(s) ? i_77 : Math.min(s, i_77), e = Number.isNaN(e) ? i_77 : Math.max(e, i_77));
                } i[0] = s, i[1] = e; }));
            return null === e ? null : __assign(__assign({}, e), { ee: "custom" });
        };
        zs.prototype.zM = function () { var t = this.ae.Sa(); this.kM = this.ae.Ua().Eh().map((function (i) { return (__assign(__assign({ wt: i.$n, _t: NaN }, t.Sh(i.$n)), { HM: i.ue })); })); };
        zs.prototype.OM = function (t, i) { i.Ic(this.kM, m(this.TM)); };
        zs.prototype.NM = function () { this.Yh.update({ bars: this.kM.map(Ls), barSpacing: this.le.Bt().ml(), visibleRange: this.TM, conflationFactor: this.le.Bt().sd() }, this.ae.N()); };
        zs.prototype.WM = function (t) { var i = this.ae.zt(); return null === i ? null : this.ae.Ft().Nt(t, i.Wt); };
        return zs;
    }(Es));
    function Ls(t) { return { x: t._t, time: t.wt, originalData: t.HM, barColor: t.sh }; }
    var Os = { color: "#2196f3" }, Ns = function (t, i, n) { var s = l(n); return new zs(t, i, s); };
    function Fs(t) { var i = { value: t.Wt[3], time: t.Qr }; return void 0 !== t.iM && (i.customValues = t.iM), i; }
    function Ws(t) { var i = Fs(t); return void 0 !== t.R && (i.color = t.R), i; }
    function Hs(t) { var i = Fs(t); return void 0 !== t.vt && (i.lineColor = t.vt), void 0 !== t.ah && (i.topColor = t.ah), void 0 !== t.oh && (i.bottomColor = t.oh), i; }
    function Us(t) { var i = Fs(t); return void 0 !== t._h && (i.topLineColor = t._h), void 0 !== t.uh && (i.bottomLineColor = t.uh), void 0 !== t.dh && (i.topFillColor1 = t.dh), void 0 !== t.fh && (i.topFillColor2 = t.fh), void 0 !== t.ph && (i.bottomFillColor1 = t.ph), void 0 !== t.mh && (i.bottomFillColor2 = t.mh), i; }
    function $s(t) { var i = { open: t.Wt[0], high: t.Wt[1], low: t.Wt[2], close: t.Wt[3], time: t.Qr }; return void 0 !== t.iM && (i.customValues = t.iM), i; }
    function js(t) { var i = $s(t); return void 0 !== t.R && (i.color = t.R), i; }
    function qs(t) { var i = $s(t), n = t.R, s = t.Ht, e = t.hh; return void 0 !== n && (i.color = n), void 0 !== s && (i.borderColor = s), void 0 !== e && (i.wickColor = e), i; }
    function Ys(t) { return { Area: Hs, Line: Ws, Baseline: Us, Histogram: Ws, Bar: js, Candlestick: qs, Custom: Ks }[t]; }
    function Ks(t) { var i = t.Qr; return __assign(__assign({}, t.ue), { time: i }); }
    var Gs = { vertLine: { color: "#9598A1", width: 1, style: 3, visible: !0, labelVisible: !0, labelBackgroundColor: "#131722" }, horzLine: { color: "#9598A1", width: 1, style: 3, visible: !0, labelVisible: !0, labelBackgroundColor: "#131722" }, mode: 1, doNotSnapToHiddenSeriesIndices: !1 }, Zs = { vertLines: { color: "#D6DCDE", style: 0, visible: !0 }, horzLines: { color: "#D6DCDE", style: 0, visible: !0 } }, Xs = { background: { type: "solid", color: "#FFFFFF" }, textColor: "#191919", fontSize: 12, fontFamily: w, panes: { enableResize: !0, separatorColor: "#E0E3EB", separatorHoverColor: "rgba(178, 181, 189, 0.2)" }, attributionLogo: !0, colorSpace: "srgb", colorParsers: [] }, Js = { autoScale: !0, mode: 0, invertScale: !1, alignLabels: !0, borderVisible: !0, borderColor: "#2B2B43", entireTextOnly: !1, visible: !1, ticksVisible: !1, scaleMargins: { bottom: .1, top: .2 }, minimumWidth: 0, ensureEdgeTickMarksVisible: !1, tickMarkDensity: 2.5 }, Qs = { rightOffset: 0, barSpacing: 6, minBarSpacing: .5, maxBarSpacing: 0, fixLeftEdge: !1, fixRightEdge: !1, lockVisibleTimeRangeOnResize: !1, rightBarStaysOnScroll: !1, borderVisible: !0, borderColor: "#2B2B43", visible: !0, timeVisible: !1, secondsVisible: !0, shiftVisibleRangeOnNewBar: !0, allowShiftVisibleRangeOnWhitespaceReplacement: !1, ticksVisible: !1, uniformDistribution: !1, minimumHeight: 0, allowBoldLabels: !0, ignoreWhitespaceIndices: !1, enableConflation: !1, conflationThresholdFactor: 1, precomputeConflationOnInit: !1, precomputeConflationPriority: "background" };
    function te() { return { addDefaultPane: !0, hoveredSeriesOnTop: !0, width: 0, height: 0, autoSize: !1, layout: Xs, crosshair: Gs, grid: Zs, overlayPriceScales: __assign({}, Js), leftPriceScale: __assign(__assign({}, Js), { visible: !1 }), rightPriceScale: __assign(__assign({}, Js), { visible: !0 }), defaultVisiblePriceScaleId: "right", timeScale: Qs, localization: { locale: vn ? navigator.language : "", dateFormat: "dd MMM 'yy" }, handleScroll: { mouseWheel: !0, pressedMouseMove: !0, horzTouchDrag: !0, vertTouchDrag: !0 }, handleScale: { axisPressedMouseMove: { time: !0, price: !0 }, axisDoubleClickReset: { time: !0, price: !0 }, mouseWheel: !0, pinch: !0 }, kineticScroll: { mouse: !1, touch: !0 }, trackingMode: { exitMode: 1 } }; }
    var ie = /** @class */ (function () {
        function ie(t, i, n) {
            this.hv = t, this.UM = i, this.$M = n !== null && n !== void 0 ? n : 0;
        }
        ie.prototype.applyOptions = function (t) { this.hv.Qt().Dd(this.UM, t, this.$M); };
        ie.prototype.options = function () { return this.Ki().N(); };
        ie.prototype.width = function () { return q(this.UM) ? this.hv.Dg(this.UM) : 0; };
        ie.prototype.setVisibleRange = function (t) { this.setAutoScale(!1), this.Ki().Go(new dt(t.from, t.to)); };
        ie.prototype.getVisibleRange = function () { var t, i, n = this.Ki().ar(); if (null === n)
            return null; if (this.Ki().ho()) {
            var s_44 = this.Ki().S_(), e_24 = Ui(s_44);
            n = ci(n, this.Ki().lo()), t = Number((Math.round(n.Je() / s_44) * s_44).toFixed(e_24)), i = Number((Math.round(n.Qe() / s_44) * s_44).toFixed(e_24));
        }
        else
            t = n.Je(), i = n.Qe(); return { from: t, to: i }; };
        ie.prototype.setAutoScale = function (t) { this.applyOptions({ autoScale: t }); };
        ie.prototype.Ki = function () { return a(this.hv.Qt().Id(this.UM, this.$M)).Ft; };
        return ie;
    }());
    var ne = /** @class */ (function () {
        function ne(t, i, n, s) {
            this.hv = t, this.yt = n, this.jM = i, this.qM = s;
        }
        ne.prototype.getHeight = function () { return this.yt.$t(); };
        ne.prototype.setHeight = function (t) { var i = this.hv.Qt(), n = i._f(this.yt); i.zd(n, t); };
        ne.prototype.getStretchFactor = function () { return this.yt.F_(); };
        ne.prototype.setStretchFactor = function (t) { this.yt.W_(t), this.hv.Qt().ka(); };
        ne.prototype.paneIndex = function () { return this.hv.Qt()._f(this.yt); };
        ne.prototype.moveTo = function (t) { var i = this.paneIndex(); i !== t && (r(t >= 0 && t < this.hv.lv().length, "Invalid pane index"), this.hv.Qt().Od(i, t)); };
        ne.prototype.getSeries = function () {
            var _this = this;
            var _j;
            return (_j = this.yt.Y_().map((function (t) { return _this.jM(t); }))) !== null && _j !== void 0 ? _j : [];
        };
        ne.prototype.getHTMLElement = function () { var t = this.hv.lv(); return t && 0 !== t.length && t[this.paneIndex()] ? t[this.paneIndex()].fv() : null; };
        ne.prototype.attachPrimitive = function (t) {
            var _this = this;
            this.yt.ol(t), t.attached && t.attached({ chart: this.qM, requestUpdate: function () { return _this.yt.Qt().ka(); } });
        };
        ne.prototype.detachPrimitive = function (t) { this.yt._l(t); };
        ne.prototype.priceScale = function (t) { if (null === this.yt.O_(t))
            throw new Error("Cannot find price scale with id: ".concat(t)); return new ie(this.hv, t, this.paneIndex()); };
        ne.prototype.setPreserveEmptyPane = function (t) { this.yt.j_(t); };
        ne.prototype.preserveEmptyPane = function () { return this.yt.q_(); };
        ne.prototype.addCustomSeries = function (t, i, n) {
            if (i === void 0) { i = {}; }
            if (n === void 0) { n = 0; }
            return this.qM.addCustomSeries(t, i, n);
        };
        ne.prototype.addSeries = function (t, i) {
            if (i === void 0) { i = {}; }
            return this.qM.addSeries(t, i, this.paneIndex());
        };
        return ne;
    }());
    var se = { color: "#FF0000", price: 0, lineStyle: 2, lineWidth: 1, lineVisible: !0, axisLabelVisible: !0, title: "", axisLabelColor: "", axisLabelTextColor: "" };
    var ee = /** @class */ (function () {
        function ee(t) {
            this._r = t;
        }
        ee.prototype.applyOptions = function (t) { this._r.vr(t); };
        ee.prototype.options = function () { return this._r.N(); };
        ee.prototype.YM = function () { return this._r; };
        return ee;
    }());
    var re = /** @class */ (function () {
        function re(t, i, n, s, e, r) {
            this.KM = new o, this.ae = t, this.GM = i, this.ZM = n, this.Pu = e, this.qM = s, this.XM = r;
        }
        re.prototype.m = function () { this.KM.m(); };
        re.prototype.priceFormatter = function () { return this.ae.sl(); };
        re.prototype.priceToCoordinate = function (t) { var i = this.ae.zt(); return null === i ? null : this.ae.Ft().Nt(t, i.Wt); };
        re.prototype.coordinateToPrice = function (t) { var i = this.ae.zt(); return null === i ? null : this.ae.Ft().Tn(t, i.Wt); };
        re.prototype.barsInLogicalRange = function (t) { if (null === t)
            return null; var i = new Bi(new Ii(t.from, t.to)).Uu(), n = this.ae.Un(); if (n.Zi())
            return null; var s = n.Hn(i.Na(), 1), e = n.Hn(i.bi(), -1), r = a(n.Rh()), h = a(n.Qn()); if (null !== s && null !== e && s.$n > e.$n)
            return { barsBefore: t.from - r, barsAfter: h - t.to }; var l = { barsBefore: null === s || s.$n === r ? t.from - r : s.$n - r, barsAfter: null === e || e.$n === h ? h - t.to : h - e.$n }; return null !== s && null !== e && (l.from = s.Qr, l.to = e.Qr), l; };
        re.prototype.setData = function (t) { this.Pu, this.ae.bh(), this.GM.JM(this.ae, t), this.QM("full"); };
        re.prototype.update = function (t, i) {
            if (i === void 0) { i = !1; }
            this.ae.bh(), this.GM.tb(this.ae, t, i), this.QM("update");
        };
        re.prototype.pop = function (t) {
            if (t === void 0) { t = 1; }
            var i = this.GM.ib(this.ae, t);
            0 !== i.length && this.QM("update");
            var n = Ys(this.seriesType());
            return i.map((function (t) { return n(t); }));
        };
        re.prototype.dataByIndex = function (t, i) { var n = this.ae.Un().Hn(t, i); if (null === n)
            return null; return Ys(this.seriesType())(n); };
        re.prototype.data = function () { var t = Ys(this.seriesType()); return this.ae.Un().Eh().map((function (i) { return t(i); })); };
        re.prototype.subscribeDataChanged = function (t) { this.KM.i(t); };
        re.prototype.unsubscribeDataChanged = function (t) { this.KM._(t); };
        re.prototype.applyOptions = function (t) { this.ae.vr(t); };
        re.prototype.options = function () { return p(this.ae.N()); };
        re.prototype.priceScale = function () { return this.ZM.priceScale(this.ae.Ft().pl(), this.getPane().paneIndex()); };
        re.prototype.createPriceLine = function (t) { var i = _(p(se), t), n = this.ae.Ba(i); return new ee(n); };
        re.prototype.removePriceLine = function (t) { this.ae.Aa(t.YM()); };
        re.prototype.priceLines = function () { return this.ae.za().map((function (t) { return new ee(t); })); };
        re.prototype.seriesType = function () { return this.ae.bh(); };
        re.prototype.lastValueData = function (t) { var i = this.ae.Ae(t); return i.ze ? { noData: !0 } : { noData: !1, price: i.gt, color: i.R }; };
        re.prototype.attachPrimitive = function (t) {
            var _this = this;
            this.ae.ol(t), t.attached && t.attached({ chart: this.qM, series: this, requestUpdate: function () { return _this.ae.Qt().ka(); }, horzScaleBehavior: this.Pu });
        };
        re.prototype.detachPrimitive = function (t) { this.ae._l(t), t.detached && t.detached(), this.ae.Qt().ka(); };
        re.prototype.getPane = function () { var t = this.ae, i = a(this.ae.Qt().Ks(t)); return this.XM(i); };
        re.prototype.moveToPane = function (t) { this.ae.Qt().rf(this.ae, t); };
        re.prototype.seriesOrder = function () { var t = this.ae.Qt().Ks(this.ae); return null === t ? -1 : t.Y_().indexOf(this.ae); };
        re.prototype.setSeriesOrder = function (t) { var i = this.ae.Qt().Ks(this.ae); null !== i && i.vu(this.ae, t); };
        re.prototype.QM = function (t) { this.KM.v() && this.KM.p(t); };
        return re;
    }());
    var he = /** @class */ (function () {
        function he(t, i, n) {
            this.nb = new o, this.Qu = new o, this.Nw = new o, this.sn = t, this.ia = t.Bt(), this.vg = i, this.ia.Zc().i(this.sb.bind(this)), this.ia.Xc().i(this.eb.bind(this)), this.vg.qw().i(this.rb.bind(this)), this.Pu = n;
        }
        he.prototype.m = function () { this.ia.Zc().u(this), this.ia.Xc().u(this), this.vg.qw().u(this), this.nb.m(), this.Qu.m(), this.Nw.m(); };
        he.prototype.scrollPosition = function () { return this.ia.Oc(); };
        he.prototype.scrollToPosition = function (t, i) { i ? this.ia.Yc(t, 1e3) : this.sn.Ms(t); };
        he.prototype.scrollToRealTime = function () { this.ia.qc(); };
        he.prototype.getVisibleRange = function () { var t = this.ia.xc(); return null === t ? null : { from: t.from.originalTime, to: t.to.originalTime }; };
        he.prototype.setVisibleRange = function (t) { var i = { from: this.Pu.convertHorzItemToInternal(t.from), to: this.Pu.convertHorzItemToInternal(t.to) }, n = this.ia.kc(i); this.sn.sf(n); };
        he.prototype.getVisibleLogicalRange = function () { var t = this.ia.Sc(); return null === t ? null : { from: t.Na(), to: t.bi() }; };
        he.prototype.setVisibleLogicalRange = function (t) { r(t.from <= t.to, "The from index cannot be after the to index."), this.sn.sf(t); };
        he.prototype.resetTimeScale = function () { this.sn.ws(); };
        he.prototype.fitContent = function () { this.sn.td(); };
        he.prototype.logicalToCoordinate = function (t) { var i = this.sn.Bt(); return i.Zi() ? null : i.jt(t); };
        he.prototype.coordinateToLogical = function (t) { return this.ia.Zi() ? null : this.ia.Vc(t); };
        he.prototype.timeToIndex = function (t, i) { var n = this.Pu.convertHorzItemToInternal(t); return this.ia.gc(n, i); };
        he.prototype.timeToCoordinate = function (t) { var i = this.timeToIndex(t, !1); return null === i ? null : this.ia.jt(i); };
        he.prototype.coordinateToTime = function (t) { var i = this.sn.Bt(), n = i.Vc(t), s = i.en(n); return null === s ? null : s.originalTime; };
        he.prototype.width = function () { return this.vg.pv().width; };
        he.prototype.height = function () { return this.vg.pv().height; };
        he.prototype.subscribeVisibleTimeRangeChange = function (t) { this.nb.i(t); };
        he.prototype.unsubscribeVisibleTimeRangeChange = function (t) { this.nb._(t); };
        he.prototype.subscribeVisibleLogicalRangeChange = function (t) { this.Qu.i(t); };
        he.prototype.unsubscribeVisibleLogicalRangeChange = function (t) { this.Qu._(t); };
        he.prototype.subscribeSizeChange = function (t) { this.Nw.i(t); };
        he.prototype.unsubscribeSizeChange = function (t) { this.Nw._(t); };
        he.prototype.applyOptions = function (t) { this.ia.vr(t); };
        he.prototype.options = function () { return __assign(__assign({}, p(this.ia.N())), { barSpacing: this.ia.ml() }); };
        he.prototype.sb = function () { this.nb.v() && this.nb.p(this.getVisibleRange()); };
        he.prototype.eb = function () { this.Qu.v() && this.Qu.p(this.getVisibleLogicalRange()); };
        he.prototype.rb = function (t) { this.Nw.p(t.width, t.height); };
        return he;
    }());
    function ae(t) { return function (t) { if (f(t.handleScale)) {
        var i_78 = t.handleScale;
        t.handleScale = { axisDoubleClickReset: { time: i_78, price: i_78 }, axisPressedMouseMove: { time: i_78, price: i_78 }, mouseWheel: i_78, pinch: i_78 };
    }
    else if (void 0 !== t.handleScale) {
        var _j = t.handleScale, i_79 = _j.axisPressedMouseMove, n_63 = _j.axisDoubleClickReset;
        f(i_79) && (t.handleScale.axisPressedMouseMove = { time: i_79, price: i_79 }), f(n_63) && (t.handleScale.axisDoubleClickReset = { time: n_63, price: n_63 });
    } var i = t.handleScroll; f(i) && (t.handleScroll = { horzTouchDrag: i, vertTouchDrag: i, mouseWheel: i, pressedMouseMove: i }); }(t), t; }
    var le = /** @class */ (function () {
        function le(t, i, n) {
            var _this = this;
            this.hb = new Map, this.ab = new Map, this.lb = new o, this.ob = new o, this._b = new o, this.dd = new WeakMap, this.ub = new ms(i);
            var s = void 0 === n ? p(te()) : _(p(te()), ae(n));
            this.cb = i, this.hv = new ts(t, s, i), this.hv.mw().i((function (t) { _this.lb.v() && _this.lb.p(_this.fb(t())); }), this), this.hv.ww().i((function (t) { _this.ob.v() && _this.ob.p(_this.fb(t())); }), this), this.hv.Ed().i((function (t) { _this._b.v() && _this._b.p(_this.fb(t())); }), this);
            var e = this.hv.Qt();
            this.pb = new he(e, this.hv.bg(), this.cb);
        }
        le.prototype.remove = function () { this.hv.mw().u(this), this.hv.ww().u(this), this.hv.Ed().u(this), this.pb.m(), this.hv.m(), this.hb.clear(), this.ab.clear(), this.lb.m(), this.ob.m(), this._b.m(), this.ub.m(); };
        le.prototype.resize = function (t, i, n) { this.autoSizeActive() || this.hv.wg(t, i, n); };
        le.prototype.addCustomSeries = function (t, i, n) {
            if (i === void 0) { i = {}; }
            if (n === void 0) { n = 0; }
            var s = (function (t) { return ({ type: "Custom", isBuiltIn: !1, defaultOptions: __assign(__assign({}, Os), t.defaultOptions()), mb: Ns, wb: t }); })(l(t));
            return this.gb(s, i, n);
        };
        le.prototype.addSeries = function (t, i, n) {
            if (i === void 0) { i = {}; }
            if (n === void 0) { n = 0; }
            return this.gb(t, i, n);
        };
        le.prototype.removeSeries = function (t) { var i = h(this.hb.get(t)), n = this.ub.if(i); this.hv.Qt().if(i), this.Mb(n), this.hb.delete(t), this.ab.delete(i); };
        le.prototype.JM = function (t, i) { this.Mb(this.ub.oM(t, i)); };
        le.prototype.tb = function (t, i, n) { this.Mb(this.ub.pM(t, i, n)); };
        le.prototype.ib = function (t, i) { var _j = this.ub.wM(t, i), n = _j[0], s = _j[1]; return 0 !== n.length && this.Mb(s), n; };
        le.prototype.subscribeClick = function (t) { this.lb.i(t); };
        le.prototype.unsubscribeClick = function (t) { this.lb._(t); };
        le.prototype.subscribeCrosshairMove = function (t) { this._b.i(t); };
        le.prototype.unsubscribeCrosshairMove = function (t) { this._b._(t); };
        le.prototype.subscribeDblClick = function (t) { this.ob.i(t); };
        le.prototype.unsubscribeDblClick = function (t) { this.ob._(t); };
        le.prototype.priceScale = function (t, i) {
            if (i === void 0) { i = 0; }
            return new ie(this.hv, t, i);
        };
        le.prototype.timeScale = function () { return this.pb; };
        le.prototype.applyOptions = function (t) { this.hv.vr(ae(t)); };
        le.prototype.options = function () { return this.hv.N(); };
        le.prototype.takeScreenshot = function (t, i) {
            if (t === void 0) { t = !1; }
            if (i === void 0) { i = !1; }
            var n, s;
            try {
                i || (n = this.hv.Qt().N().crosshair.mode, this.hv.vr({ crosshair: { mode: 2 } })), s = this.hv.Tg(t);
            }
            finally {
                i || void 0 === n || this.hv.Qt().vr({ crosshair: { mode: n } });
            }
            return s;
        };
        le.prototype.addPane = function (t) {
            if (t === void 0) { t = !1; }
            var i = this.hv.Qt().uf();
            return i.j_(t), this.bb(i);
        };
        le.prototype.removePane = function (t) { this.hv.Qt().Ad(t); };
        le.prototype.swapPanes = function (t, i) { this.hv.Qt().Ld(t, i); };
        le.prototype.autoSizeActive = function () { return this.hv.Cg(); };
        le.prototype.chartElement = function () { return this.hv.gv(); };
        le.prototype.panes = function () {
            var _this = this;
            return this.hv.Qt().Gn().map((function (t) { return _this.bb(t); }));
        };
        le.prototype.paneSize = function (t) {
            if (t === void 0) { t = 0; }
            var i = this.hv.Ag(t);
            return { height: i.height, width: i.width };
        };
        le.prototype.setCrosshairPosition = function (t, i, n) { var s = this.hb.get(n); if (void 0 === s)
            return; var e = this.hv.Qt().Ks(s); null !== e && this.hv.Qt().Gd(t, i, e); };
        le.prototype.clearCrosshairPosition = function () { this.hv.Qt().Zd(!0); };
        le.prototype.horzBehaviour = function () { return this.cb; };
        le.prototype.gb = function (i, n, s) {
            var _this = this;
            if (n === void 0) { n = {}; }
            if (s === void 0) { s = 0; }
            r(void 0 !== i.mb), function (t) { if (void 0 === t || "custom" === t.type)
                return; var i = t; void 0 !== i.minMove && void 0 === i.precision && (i.precision = Ui(i.minMove)); }(n.priceFormat), "Candlestick" === i.type && function (t) { void 0 !== t.borderColor && (t.borderUpColor = t.borderColor, t.borderDownColor = t.borderColor), void 0 !== t.wickColor && (t.wickUpColor = t.wickColor, t.wickDownColor = t.wickColor); }(n);
            var e = _(p(t), p(i.defaultOptions), n), h = i.mb, a = new Kt(this.hv.Qt(), i.type, e, h, i.wb);
            this.hv.Qt().Qd(a, s);
            var l = new re(a, this, this, this, this.cb, (function (t) { return _this.bb(t); }));
            return this.hb.set(l, a), this.ab.set(a, l), l;
        };
        le.prototype.Mb = function (t) { var i = this.hv.Qt(); for (var _j = 0, _k = t.Y_.keys(); _j < _k.length; _j++) {
            var i_80 = _k[_j];
            i_80.Ia();
        } i.Xd(t.Bt.Dc, t.Bt.SM, t.Bt.xM), t.Y_.forEach((function (t, i) { return i.ht(t.ue, t.bM); })), i.Bt().dc(), i.zc(); };
        le.prototype.Sb = function (t) { return h(this.ab.get(t)); };
        le.prototype.xb = function (t) { return void 0 !== t && this.ab.has(t) ? this.Sb(t) : void 0; };
        le.prototype.fb = function (t) {
            var _this = this;
            var i = new Map;
            t.Qg.forEach((function (t, n) { var s = n.bh(), e = Ys(s)(t); if ("Custom" !== s)
                r(ss(e));
            else {
                var t_83 = n.cl();
                r(!t_83 || !1 === t_83(e));
            } i.set(_this.Sb(n), e); }));
            var n = this.xb(t.jg), s = void 0 === t.Yg ? void 0 : { type: t.Yg.ds, sourceKind: t.Yg.Kg, objectKind: t.Yg.Gg, series: this.xb(t.Yg.Y_), objectId: t.Yg.Zg, paneIndex: t.Yg.Xg };
            return { time: t.Qr, logical: t.$n, point: t.Jg, paneIndex: t.Xg, hoveredInfo: s, hoveredSeries: n, hoveredObjectId: t.qg, seriesData: i, sourceEvent: t.tM };
        };
        le.prototype.bb = function (t) {
            var _this = this;
            var i = this.dd.get(t);
            return i || (i = new ne(this.hv, (function (t) { return _this.Sb(t); }), t, this), this.dd.set(t, i)), i;
        };
        return le;
    }());
    function oe(t) { if (d(t)) {
        var i_81 = document.getElementById(t);
        return r(null !== i_81, "Cannot find element in DOM with id=".concat(t)), i_81;
    } return t; }
    function _e(t, i, n) { var s = oe(t), e = new le(s, i, n); return i.setOptions(e.options()), e; }
    function ue(t, i, n, s) { return Math.hypot(n - t, s - i); }
    function ce(t, i, n, s, e, r, h, a) {
        if (a === void 0) { a = 0; }
        if (0 === i.length || s.from >= i.length || s.to <= 0)
            return;
        var l = t.context, o = t.horizontalPixelRatio, _ = t.verticalPixelRatio, u = i[s.from];
        var c = r(t, u), d = u;
        if (s.to - s.from < 2) {
            var i_82 = e / 2;
            l.beginPath();
            var n_64 = { _t: u._t - i_82, ut: u.ut }, s_45 = { _t: u._t + i_82, ut: u.ut };
            l.moveTo(n_64._t * o, n_64.ut * _), l.lineTo(s_45._t * o, s_45.ut * _), h(t, c, n_64, s_45);
        }
        else {
            var e_25 = a > 0;
            var f_3 = 0;
            var p_2 = function (i, n) { if (h(t, c, d, n), l.beginPath(), c = i, d = n, e_25) {
                var t_84 = f_3 % a;
                l.lineDashOffset = t_84, f_3 = t_84;
            } };
            var v_2 = d;
            l.beginPath(), l.moveTo(u._t * o, u.ut * _);
            for (var h_12 = s.from + 1; h_12 < s.to; ++h_12) {
                v_2 = i[h_12];
                var s_46 = v_2._t * o, a_14 = v_2.ut * _, u_7 = r(t, v_2);
                switch (n) {
                    case 0:
                        if (l.lineTo(s_46, a_14), e_25) {
                            var t_85 = i[h_12 - 1], n_65 = t_85._t * o, e_26 = t_85.ut * _;
                            f_3 += ue(n_65, e_26, s_46, a_14);
                        }
                        break;
                    case 1: {
                        var t_86 = i[h_12 - 1], n_66 = t_86.ut * _;
                        l.lineTo(s_46, n_66), e_25 && (f_3 += Math.abs(v_2._t - t_86._t) * o), u_7 !== c && (p_2(u_7, v_2), l.lineTo(s_46, n_66)), l.lineTo(s_46, a_14), e_25 && (f_3 += Math.abs(v_2.ut - t_86.ut) * _);
                        break;
                    }
                    case 2: {
                        var _j = ve(i, h_12 - 1, h_12), t_87 = _j[0], n_67 = _j[1], r_17 = t_87._t * o, u_8 = t_87.ut * _, c_4 = n_67._t * o, d_2 = n_67.ut * _;
                        if (l.bezierCurveTo(r_17, u_8, c_4, d_2, s_46, a_14), e_25) {
                            var t_88 = i[h_12 - 1], n_68 = t_88._t * o, e_27 = t_88.ut * _, l_14 = ue(n_68, e_27, s_46, a_14), p_3 = ue(n_68, e_27, r_17, u_8) + ue(r_17, u_8, c_4, d_2) + ue(c_4, d_2, s_46, a_14);
                            f_3 += (l_14 + p_3) / 2;
                        }
                        break;
                    }
                }
                1 !== n && u_7 !== c && (p_2(u_7, v_2), l.moveTo(s_46, a_14));
            }
            (d !== v_2 || d === v_2 && 1 === n) && h(t, c, d, v_2), e_25 && (l.lineDashOffset = 0);
        }
    }
    var de = 6;
    function fe(t, i) { return { _t: t._t - i._t, ut: t.ut - i.ut }; }
    function pe(t, i) { return { _t: t._t / i, ut: t.ut / i }; }
    function ve(t, i, n) { var s = Math.max(0, i - 1), e = Math.min(t.length - 1, n + 1); var r, h; return [(r = t[i], h = pe(fe(t[n], t[s]), de), { _t: r._t + h._t, ut: r.ut + h.ut }), fe(t[n], pe(fe(t[e], t[i]), de))]; }
    function me(t, i) { var n = t.context; n.strokeStyle = i, n.stroke(); }
    var we = /** @class */ (function (_super) {
        __extends(we, _super);
        function we() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.rt = null;
            return _this;
        }
        we.prototype.ht = function (t) { this.rt = t; };
        we.prototype.et = function (t) { if (null === this.rt)
            return; var _j = this.rt, i = _j.ot, n = _j.lt, e = _j.Cb, r = _j.yb, h = _j.ct, a = _j.Gt, l = _j.Pb; if (null === n)
            return; var o = t.context; o.lineCap = "butt", o.lineWidth = h * t.verticalPixelRatio; var _ = s(o, a); o.lineJoin = "round"; var u = this.kb.bind(this), c = function (t) { return t.reduce((function (t, i) { return t + i; }), 0); }(_); void 0 !== r && ce(t, i, r, n, e, u, me, c), l && function (t, i, n, s, e) { if (s.to - s.from <= 0)
            return; var r = t.horizontalPixelRatio, h = t.verticalPixelRatio, a = t.context; var l = null; var o = Math.max(1, Math.floor(r)) % 2 / 2, _ = n * h + o; for (var n_69 = s.to - 1; n_69 >= s.from; --n_69) {
            var s_47 = i[n_69];
            if (s_47) {
                var i_83 = e(t, s_47);
                i_83 !== l && (null !== l && a.fill(), a.beginPath(), a.fillStyle = i_83, l = i_83);
                var n_70 = Math.round(s_47._t * r) + o, u_9 = s_47.ut * h;
                a.moveTo(n_70, u_9), a.arc(n_70, u_9, _, 0, 2 * Math.PI);
            }
        } a.fill(); }(t, i, l, n, u); };
        return we;
    }(y));
    var ge = /** @class */ (function (_super) {
        __extends(ge, _super);
        function ge() {
            return _super !== null && _super.apply(this, arguments) || this;
        }
        ge.prototype.kb = function (t, i) { return i.vt; };
        return ge;
    }(we));
    function Me(t, i, n, s, e) { var r = 1 - e; return r * r * r * t + 3 * r * r * e * i + 3 * r * e * e * n + e * e * e * s; }
    function be(t, i, n, s, e) { if (2 === n) {
        var _j = ve(s, e - 1, e), n_71 = _j[0], r_18 = _j[1];
        return [Math.min(t._t, i._t, n_71._t, r_18._t), Math.max(t._t, i._t, n_71._t, r_18._t)];
    } return [Math.min(t._t, i._t), Math.max(t._t, i._t)]; }
    function Se(t, i, n, s, e, r, h, a) { switch (e) {
        case 1: {
            var e_28 = ys(t, i, n._t, n.ut, s._t, n.ut), r_19 = ys(t, i, s._t, n.ut, s._t, s.ut), h_13 = Math.min(e_28, r_19);
            return h_13 <= a ? h_13 : null;
        }
        case 2: {
            var _j = ve(r, h - 1, h), e_29 = _j[0], l_15 = _j[1], o_10 = function (t, i, n) { var s = Number.POSITIVE_INFINITY, e = n[0]; for (var r_20 = 1; r_20 <= 12; r_20++) {
                var h_14 = r_20 / 12, a_15 = { _t: Me(n[0]._t, n[1]._t, n[2]._t, n[3]._t, h_14), ut: Me(n[0].ut, n[1].ut, n[2].ut, n[3].ut, h_14) };
                s = Math.min(s, ys(t, i, e._t, e.ut, a_15._t, a_15.ut)), e = a_15;
            } return s; }(t, i, [n, e_29, l_15, s]);
            return o_10 <= a ? o_10 : null;
        }
        default: {
            var e_30 = ys(t, i, n._t, n.ut, s._t, s.ut);
            return e_30 <= a ? e_30 : null;
        }
    } }
    var xe = /** @class */ (function (_super) {
        __extends(xe, _super);
        function xe(t, i) {
            return _super.call(this, t, i, !0) || this;
        }
        xe.prototype.OM = function (t, i, n) { i.Ic(this.kM, m(this.TM)), t.Jo(this.kM, n, m(this.TM)); };
        xe.prototype.Tb = function (t, i) { return { wt: t, gt: i, _t: NaN, ut: NaN }; };
        xe.prototype.zM = function () {
            var _this = this;
            var t = this.ae.Sa();
            this.kM = this.ae.Ua().Eh().map((function (i) { var _j; var n; if (((_j = i.Gr) !== null && _j !== void 0 ? _j : 1) > 1) {
                var t_89 = i.Wt[1], s_48 = i.Wt[2], e_31 = i.Wt[3];
                n = Math.abs(t_89 - e_31) > Math.abs(s_48 - e_31) ? t_89 : s_48;
            }
            else
                n = i.Wt[3]; return _this.Rb(i.$n, n, t); }));
        };
        return xe;
    }(Es));
    var Ce = /** @class */ (function (_super) {
        __extends(Ce, _super);
        function Ce() {
            return _super !== null && _super.apply(this, arguments) || this;
        }
        Ce.prototype.EM = function (t, i) { var n = this.ae.N(); return function (t, i, n, s, e, r, h, a, l) {
            if (a === void 0) { a = 0; }
            if (l === void 0) { l = 0; }
            if (null === i || i.from >= i.to || 0 === t.length)
                return null;
            var o = Math.max(r / 2, h !== null && h !== void 0 ? h : 0) + l;
            var _ = Number.POSITIVE_INFINITY;
            if (void 0 !== h) {
                var e_32 = h + l, r_21 = bs(t, n - e_32, i.from, i.to), a_16 = Ss(t, n + e_32, r_21, i.to);
                for (var i_84 = r_21; i_84 < a_16; i_84++) {
                    var e_33 = t[i_84];
                    if (!Cs(n, e_33._t, e_33._t, h + l))
                        continue;
                    var r_22 = Math.hypot(n - e_33._t, s - e_33.ut);
                    r_22 <= h + l && (_ = Math.min(_, r_22));
                }
            }
            if (i.to - i.from < 2) {
                var e_34 = t[i.from], r_23 = Math.max(a / 2, o), h_15 = ys(n, s, e_34._t - r_23, e_34.ut, e_34._t + r_23, e_34.ut);
                return h_15 <= o && (_ = Math.min(_, h_15)), Number.isFinite(_) ? xs(_, 2, "series-point") : null;
            }
            var u = Number.POSITIVE_INFINITY;
            var c = bs(t, n - o, i.from, i.to), d = Ss(t, n + o, c, i.to), f = Math.max(i.from + 1, c), p = Math.min(i.to, d + 1);
            for (var i_85 = f; i_85 < p; i_85++) {
                var r_24 = t[i_85 - 1], h_16 = t[i_85], _j = be(r_24, h_16, e, t, i_85), a_17 = _j[0], l_16 = _j[1];
                if (!Cs(n, a_17, l_16, o))
                    continue;
                var _7 = Se(n, s, r_24, h_16, e, t, i_85, o);
                null !== _7 && (u = Math.min(u, _7));
            }
            return Number.isFinite(_) ? xs(_, 2, "series-point") : Number.isFinite(u) ? xs(u, 1, "series-line") : null;
        }(this.kM, this.TM, t, i, n.lineType, n.lineVisible ? n.lineWidth : 1, n.pointMarkersVisible ? n.pointMarkersRadius || n.lineWidth / 2 + 2 : void 0, this.le.Bt().ml(), n.hitTestTolerance); };
        return Ce;
    }(xe));
    var ye = /** @class */ (function (_super) {
        __extends(ye, _super);
        function ye() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.VM = new ge;
            return _this;
        }
        ye.prototype.Rb = function (t, i, n) { return __assign(__assign({}, this.Tb(t, i)), n.Sh(t)); };
        ye.prototype.NM = function () { var t = this.ae.N(), i = { ot: this.kM, Gt: t.lineStyle, yb: t.lineVisible ? t.lineType : void 0, ct: t.lineWidth, Pb: t.pointMarkersVisible ? t.pointMarkersRadius || t.lineWidth / 2 + 2 : void 0, lt: this.TM, Cb: this.le.Bt().ml() }; this.VM.ht(i); };
        return ye;
    }(Ce));
    var Pe = { type: "Line", isBuiltIn: !0, defaultOptions: { color: "#2196f3", lineStyle: 0, lineWidth: 3, lineType: 0, lineVisible: !0, crosshairMarkerVisible: !0, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: "", crosshairMarkerBorderWidth: 2, crosshairMarkerBackgroundColor: "", lastPriceAnimation: 0, pointMarkersVisible: !1 }, mb: function (t, i) { return new ye(t, i); } };
    function ke(t, i) { return t.weight > i.weight ? t : i; }
    var Te = /** @class */ (function () {
        function Te() {
            var _this = this;
            this.Db = new o, this.Ib = function (t) { var i = !1; return function () {
                var n = [];
                for (var _j = 0; _j < arguments.length; _j++) {
                    n[_j] = arguments[_j];
                }
                i || (i = !0, queueMicrotask((function () { t.apply(void 0, n), i = !1; })));
            }; }((function () { return _this.Db.p(_this.Vb); })), this.Vb = 0;
        }
        Te.prototype.Eb = function () { return this.Db; };
        Te.prototype.m = function () { this.Db.m(); };
        Te.prototype.options = function () { return this.yn; };
        Te.prototype.setOptions = function (t) { this.yn = t; };
        Te.prototype.preprocessData = function (t) { };
        Te.prototype.updateFormatter = function (t) { this.yn && (this.yn.localization = t); };
        Te.prototype.createConverterToInternalObj = function (t) {
            var _this = this;
            return this.Ib(), function (t) { return (t > _this.Vb && (_this.Vb = t), t); };
        };
        Te.prototype.key = function (t) { return t; };
        Te.prototype.cacheKey = function (t) { return t; };
        Te.prototype.convertHorzItemToInternal = function (t) { return t; };
        Te.prototype.formatHorzItem = function (t) { return this.Bb(t); };
        Te.prototype.formatTickmark = function (t) { return this.Bb(t.time); };
        Te.prototype.maxTickMarkWeight = function (t) { return t.reduce(ke, t[0]).weight; };
        Te.prototype.fillWeightsForPoints = function (t, i) { for (var s_49 = i; s_49 < t.length; ++s_49)
            t[s_49].timeWeight = (n = t[s_49].time) % 120 == 0 ? 10 : n % 60 == 0 ? 9 : n % 36 == 0 ? 8 : n % 12 == 0 ? 7 : n % 6 == 0 ? 6 : n % 3 == 0 ? 5 : n % 1 == 0 ? 4 : 0; var n; this.Vb = t[t.length - 1].time, this.Ib(); };
        Te.prototype.Bb = function (t) { var _j; if ((_j = this.yn.localization) === null || _j === void 0 ? void 0 : _j.timeFormatter)
            return this.yn.localization.timeFormatter(t); if (t < 12)
            return "".concat(t, "M"); var i = Math.floor(t / 12), n = t % 12; return 0 === n ? "".concat(i, "Y") : "".concat(i, "Y").concat(n, "M"); };
        return Te;
    }());
    var Re = { yieldCurve: { baseResolution: 1, minimumTimeRange: 120, startTimeRange: 0 }, timeScale: { ignoreWhitespaceIndices: !0 }, leftPriceScale: { visible: !0 }, rightPriceScale: { visible: !1 }, localization: { priceFormatter: function (t) { return t.toFixed(3) + "%"; } } }, De = { lastValueVisible: !1, priceLineVisible: !1 };
    var Ie = /** @class */ (function (_super) {
        __extends(Ie, _super);
        function Ie(t, i) {
            var _this = this;
            var n = _(Re, i || {}), s = new Te;
            _this = _super.call(this, t, s, n) || this, s.setOptions(_this.options()), _this._initWhitespaceSeries();
            return _this;
        }
        Ie.prototype.addSeries = function (t, i, n) {
            if (i === void 0) { i = {}; }
            if (n === void 0) { n = 0; }
            if (t.isBuiltIn && !1 === ["Area", "Line"].includes(t.type))
                throw new Error("Yield curve only support Area and Line series");
            var s = __assign(__assign({}, De), i);
            return _super.prototype.addSeries.call(this, t, s, n);
        };
        Ie.prototype._initWhitespaceSeries = function () { var t = this.horzBehaviour(), i = this.addSeries(Pe); var n; function s(s) { var e = function (t, i) { return { me: Math.max(0, t.startTimeRange), we: Math.max(0, t.minimumTimeRange, i || 0), Ab: Math.max(1, t.baseResolution) }; }(t.options().yieldCurve, s), r = (function (_j) {
            var t = _j.me, i = _j.we, n = _j.Ab;
            return "".concat(t, "~").concat(i, "~").concat(n);
        })(e); r !== n && (n = r, i.setData(function (_j) {
            var t = _j.me, i = _j.we, n = _j.Ab;
            return Array.from({ length: Math.floor((i - t) / n) + 1 }, (function (i, s) { return ({ time: t + s * n }); }));
        }(e))); } s(0), t.Eb().i(s); };
        return Ie;
    }(le));
    function Ve(t, i) { return t.weight > i.weight ? t : i; }
    var Ee = /** @class */ (function () {
        function Ee() {
        }
        Ee.prototype.options = function () { return this.yn; };
        Ee.prototype.setOptions = function (t) { this.yn = t; };
        Ee.prototype.preprocessData = function (t) { };
        Ee.prototype.updateFormatter = function (t) { this.yn && (this.yn.localization = t); };
        Ee.prototype.createConverterToInternalObj = function (t) { return function (t) { return t; }; };
        Ee.prototype.key = function (t) { return t; };
        Ee.prototype.cacheKey = function (t) { return t; };
        Ee.prototype.convertHorzItemToInternal = function (t) { return t; };
        Ee.prototype.formatHorzItem = function (t) { return t.toFixed(this.Ds()); };
        Ee.prototype.formatTickmark = function (t, i) { return t.time.toFixed(this.Ds()); };
        Ee.prototype.maxTickMarkWeight = function (t) { return t.reduce(Ve, t[0]).weight; };
        Ee.prototype.fillWeightsForPoints = function (t, i) { for (var s_50 = i; s_50 < t.length; ++s_50)
            t[s_50].timeWeight = (n = t[s_50].time) === 100 * Math.ceil(n / 100) ? 8 : n === 50 * Math.ceil(n / 50) ? 7 : n === 25 * Math.ceil(n / 25) ? 6 : n === 10 * Math.ceil(n / 10) ? 5 : n === 5 * Math.ceil(n / 5) ? 4 : n === Math.ceil(n) ? 3 : 2 * n === Math.ceil(2 * n) ? 1 : 0; var n; };
        Ee.prototype.Ds = function () { return this.yn.localization.precision; };
        return Ee;
    }());
    function Be(t, i, n, s, e) { var r = i.context, h = i.horizontalPixelRatio, a = i.verticalPixelRatio; r.lineTo(e._t * h, t * a), r.lineTo(s._t * h, t * a), r.closePath(), r.fillStyle = n, r.fill(); }
    var Ae = /** @class */ (function (_super) {
        __extends(Ae, _super);
        function Ae() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.rt = null;
            return _this;
        }
        Ae.prototype.ht = function (t) { this.rt = t; };
        Ae.prototype.et = function (t) { var _j; if (null === this.rt)
            return; var _k = this.rt, i = _k.ot, n = _k.lt, e = _k.Cb, r = _k.ct, h = _k.Gt, a = _k.yb, l = (_j = this.rt.zb) !== null && _j !== void 0 ? _j : (this.rt.Lb ? 0 : t.mediaSize.height); if (null === n)
            return; var o = t.context; o.lineCap = "butt", o.lineJoin = "round", o.lineWidth = r, s(o, h), o.lineWidth = 1, ce(t, i, a, n, e, this.Ob.bind(this), Be.bind(null, l)); };
        return Ae;
    }(y));
    var ze = /** @class */ (function () {
        function ze() {
        }
        ze.prototype.Nb = function (t, i) { var n = this.Fb, s = i.Wb, e = i.Hb, r = i.Ub, h = i.$b, a = i.zb, l = i.jb, o = i.qb; if (void 0 === this.Yb || void 0 === n || n.Wb !== s || n.Hb !== e || n.Ub !== r || n.$b !== h || n.zb !== a || n.jb !== l || n.qb !== o) {
            var n_72 = t.verticalPixelRatio, _8 = a || l > 0 ? n_72 : 1, u_10 = l * _8, c_5 = o === t.bitmapSize.height ? o : o * _8, d_3 = (a !== null && a !== void 0 ? a : 0) * _8, f_4 = t.context.createLinearGradient(0, u_10, 0, c_5);
            if (f_4.addColorStop(0, s), null != a) {
                var t_90 = Jt((d_3 - u_10) / (c_5 - u_10), 0, 1);
                f_4.addColorStop(t_90, e), f_4.addColorStop(t_90, r);
            }
            f_4.addColorStop(1, h), this.Yb = f_4, this.Fb = i;
        } return this.Yb; };
        return ze;
    }());
    var Le = /** @class */ (function (_super) {
        __extends(Le, _super);
        function Le() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.Kb = new ze;
            return _this;
        }
        Le.prototype.Ob = function (t, i) { var _j, _k; var n = this.rt; return this.Kb.Nb(t, { Wb: i.dh, Hb: i.fh, Ub: i.ph, $b: i.mh, zb: n.zb, jb: (_j = n.jb) !== null && _j !== void 0 ? _j : 0, qb: (_k = n.qb) !== null && _k !== void 0 ? _k : t.bitmapSize.height }); };
        return Le;
    }(Ae));
    var Oe = /** @class */ (function (_super) {
        __extends(Oe, _super);
        function Oe() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.Gb = new ze;
            return _this;
        }
        Oe.prototype.kb = function (t, i) { var _j, _k; var n = this.rt; return this.Gb.Nb(t, { Wb: i._h, Hb: i._h, Ub: i.uh, $b: i.uh, zb: n.zb, jb: (_j = n.jb) !== null && _j !== void 0 ? _j : 0, qb: (_k = n.qb) !== null && _k !== void 0 ? _k : t.bitmapSize.height }); };
        return Oe;
    }(we));
    var Ne = /** @class */ (function () {
        function Ne(t, i, n, s) {
            this.Zb = t, this.Xb = i, this.Jb = n, this.Qb = s;
        }
        Ne.prototype.st = function (t, i, n) { this.Zb.st(t, i, n), !this.Jb() || i && this.Qb() || this.Xb.st(t, i, n); };
        return Ne;
    }());
    var Fe = /** @class */ (function () {
        function Fe(t, i) {
            this.Xb = t, this.tS = i;
        }
        Fe.prototype.Tt = function () { return this.tS() ? this.Xb : null; };
        return Fe;
    }());
    var We = /** @class */ (function (_super) {
        __extends(We, _super);
        function We(t, i) {
            var _this = this;
            _this = _super.call(this, t, i) || this, _this.iS = new Le, _this.nS = new Oe, _this.sS = new Fe(_this.nS, (function () { return _this.Jb(); })), _this.eS = [_this], _this.rS = [_this.sS], _this.hS = { Za: _this.eS, qa: _this.rS }, _this.VM = new Ne(_this.iS, _this.nS, (function () { return _this.Jb(); }), (function () { return _this.le.N().hoveredSeriesOnTop; }));
            return _this;
        }
        We.prototype.Ga = function () { return this.hS; };
        We.prototype.Rb = function (t, i, n) { return __assign(__assign({}, this.Tb(t, i)), n.Sh(t)); };
        We.prototype.NM = function () { var t = this.ae.zt(); if (null === t)
            return; var i = this.ae.N(), n = this.ae.Ft().Nt(i.baseValue.price, t.Wt), s = this.le.Bt().ml(); if (null === this.TM || 0 === this.kM.length)
            return; var e, r; if (i.relativeGradient) {
            e = this.kM[this.TM.from].ut, r = this.kM[this.TM.from].ut;
            for (var t_91 = this.TM.from; t_91 < this.TM.to; t_91++) {
                var i_86 = this.kM[t_91];
                i_86.ut < e && (e = i_86.ut), i_86.ut > r && (r = i_86.ut);
            }
        } this.iS.ht({ ot: this.kM, ct: i.lineWidth, Gt: i.lineStyle, yb: i.lineType, zb: n, jb: e, qb: r, Lb: !1, lt: this.TM, Cb: s }), this.nS.ht({ ot: this.kM, ct: i.lineWidth, Gt: i.lineStyle, yb: i.lineVisible ? i.lineType : void 0, Pb: i.pointMarkersVisible ? i.pointMarkersRadius || i.lineWidth / 2 + 2 : void 0, zb: n, jb: e, qb: r, lt: this.TM, Cb: s }); };
        We.prototype.Jb = function () { return this.ae.It() && null !== this.TM && this.aS(); };
        We.prototype.aS = function () { var t = this.ae.N(); return t.lineVisible || t.pointMarkersVisible; };
        return We;
    }(Ce));
    var He = { type: "Baseline", isBuiltIn: !0, defaultOptions: { baseValue: { type: "price", price: 0 }, relativeGradient: !1, topFillColor1: "rgba(38, 166, 154, 0.28)", topFillColor2: "rgba(38, 166, 154, 0.05)", topLineColor: "rgba(38, 166, 154, 1)", bottomFillColor1: "rgba(239, 83, 80, 0.05)", bottomFillColor2: "rgba(239, 83, 80, 0.28)", bottomLineColor: "rgba(239, 83, 80, 1)", lineWidth: 3, lineStyle: 0, lineType: 0, lineVisible: !0, crosshairMarkerVisible: !0, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: "", crosshairMarkerBorderWidth: 2, crosshairMarkerBackgroundColor: "", lastPriceAnimation: 0, pointMarkersVisible: !1 }, mb: function (t, i) { return new We(t, i); } };
    var Ue = /** @class */ (function (_super) {
        __extends(Ue, _super);
        function Ue() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.Kb = new ze;
            return _this;
        }
        Ue.prototype.Ob = function (t, i) { var _j, _k; return this.Kb.Nb(t, { Wb: i.ah, Hb: "", Ub: "", $b: i.oh, jb: (_k = (_j = this.rt) === null || _j === void 0 ? void 0 : _j.jb) !== null && _k !== void 0 ? _k : 0, qb: t.bitmapSize.height }); };
        return Ue;
    }(Ae));
    var $e = /** @class */ (function (_super) {
        __extends($e, _super);
        function $e(t, i) {
            var _this = this;
            _this = _super.call(this, t, i) || this, _this.lS = new Ue, _this.Xb = new ge, _this.sS = new Fe(_this.Xb, (function () { return _this.Jb(); })), _this.eS = [_this], _this.rS = [_this.sS], _this.hS = { Za: _this.eS, qa: _this.rS }, _this.VM = new Ne(_this.lS, _this.Xb, (function () { return _this.Jb(); }), (function () { return _this.le.N().hoveredSeriesOnTop; }));
            return _this;
        }
        $e.prototype.Ga = function () { return this.hS; };
        $e.prototype.Rb = function (t, i, n) { return __assign(__assign({}, this.Tb(t, i)), n.Sh(t)); };
        $e.prototype.NM = function () { var t = this.ae.N(); if (null === this.TM || 0 === this.kM.length)
            return; var i; if (t.relativeGradient) {
            i = this.kM[this.TM.from].ut;
            for (var t_92 = this.TM.from; t_92 < this.TM.to; t_92++) {
                var n_73 = this.kM[t_92];
                n_73.ut < i && (i = n_73.ut);
            }
        } this.lS.ht({ yb: t.lineType, ot: this.kM, Gt: t.lineStyle, ct: t.lineWidth, zb: null, jb: i, Lb: t.invertFilledArea, lt: this.TM, Cb: this.le.Bt().ml() }), this.Xb.ht({ yb: t.lineVisible ? t.lineType : void 0, ot: this.kM, Gt: t.lineStyle, ct: t.lineWidth, lt: this.TM, Cb: this.le.Bt().ml(), Pb: t.pointMarkersVisible ? t.pointMarkersRadius || t.lineWidth / 2 + 2 : void 0 }); };
        $e.prototype.Jb = function () { return this.ae.It() && null !== this.TM && this.aS(); };
        $e.prototype.aS = function () { var t = this.ae.N(); return t.lineVisible || t.pointMarkersVisible; };
        return $e;
    }(Ce));
    var je = { type: "Area", isBuiltIn: !0, defaultOptions: { topColor: "rgba( 46, 220, 135, 0.4)", bottomColor: "rgba( 40, 221, 100, 0)", invertFilledArea: !1, relativeGradient: !1, lineColor: "#33D778", lineStyle: 0, lineWidth: 3, lineType: 0, lineVisible: !0, crosshairMarkerVisible: !0, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: "", crosshairMarkerBorderWidth: 2, crosshairMarkerBackgroundColor: "", lastPriceAnimation: 0, pointMarkersVisible: !1 }, mb: function (t, i) { return new $e(t, i); } };
    var qe = /** @class */ (function (_super) {
        __extends(qe, _super);
        function qe() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.qt = null, _this.oS = 0, _this._S = 0;
            return _this;
        }
        qe.prototype.ht = function (t) { this.qt = t; };
        qe.prototype.et = function (_j) {
            var t = _j.context, i = _j.horizontalPixelRatio, n = _j.verticalPixelRatio;
            if (null === this.qt || 0 === this.qt.Un.length || null === this.qt.lt)
                return;
            if (this.oS = this.uS(i), this.oS >= 2) {
                Math.max(1, Math.floor(i)) % 2 != this.oS % 2 && this.oS--;
            }
            this._S = this.qt.cS ? Math.min(this.oS, Math.floor(i)) : this.oS;
            var s = null;
            var e = this._S <= this.oS && this.qt.ml >= Math.floor(1.5 * i);
            for (var r_25 = this.qt.lt.from; r_25 < this.qt.lt.to; ++r_25) {
                var h_17 = this.qt.Un[r_25];
                s !== h_17.sh && (t.fillStyle = h_17.sh, s = h_17.sh);
                var a_18 = Math.floor(.5 * this._S), l_17 = Math.round(h_17._t * i), o_11 = l_17 - a_18, _9 = this._S, u_11 = o_11 + _9 - 1, c_6 = Math.min(h_17.n_, h_17.s_), d_4 = Math.max(h_17.n_, h_17.s_), f_5 = Math.round(c_6 * n) - a_18, p_4 = Math.round(d_4 * n) + a_18, v_3 = Math.max(p_4 - f_5, this._S);
                t.fillRect(o_11, f_5, _9, v_3);
                var m_2 = Math.ceil(1.5 * this.oS);
                if (e) {
                    if (this.qt.dS) {
                        var i_87 = l_17 - m_2;
                        var s_51 = Math.max(f_5, Math.round(h_17.i_ * n) - a_18), e_35 = s_51 + _9 - 1;
                        e_35 > f_5 + v_3 - 1 && (e_35 = f_5 + v_3 - 1, s_51 = e_35 - _9 + 1), t.fillRect(i_87, s_51, o_11 - i_87, e_35 - s_51 + 1);
                    }
                    var i_88 = l_17 + m_2;
                    var s_52 = Math.max(f_5, Math.round(h_17.e_ * n) - a_18), e_36 = s_52 + _9 - 1;
                    e_36 > f_5 + v_3 - 1 && (e_36 = f_5 + v_3 - 1, s_52 = e_36 - _9 + 1), t.fillRect(u_11 + 1, s_52, i_88 - u_11, e_36 - s_52 + 1);
                }
            }
        };
        qe.prototype.uS = function (t) { var i = Math.floor(t); return Math.max(i, Math.floor(function (t, i) { return Math.floor(.3 * t * i); }(a(this.qt).ml, t))); };
        return qe;
    }(y));
    var Ye = /** @class */ (function (_super) {
        __extends(Ye, _super);
        function Ye(t, i) {
            return _super.call(this, t, i, !1) || this;
        }
        Ye.prototype.EM = function (t, i) { return Rs(this.kM, this.TM, t, i, this.le.Bt().ml(), this.ae.N().hitTestTolerance, (function (t, i) { i[0] = t.n_, i[1] = t.s_; })); };
        Ye.prototype.OM = function (t, i, n) { i.Ic(this.kM, m(this.TM)), t.t_(this.kM, n, m(this.TM)); };
        Ye.prototype.fS = function (t, i, n) { return { wt: t, jr: i.Wt[0], qr: i.Wt[1], Yr: i.Wt[2], Kr: i.Wt[3], _t: NaN, i_: NaN, n_: NaN, s_: NaN, e_: NaN }; };
        Ye.prototype.zM = function () {
            var _this = this;
            var t = this.ae.Sa();
            this.kM = this.ae.Ua().Eh().map((function (i) { return _this.Rb(i.$n, i, t); }));
        };
        return Ye;
    }(Es));
    var Ke = /** @class */ (function (_super) {
        __extends(Ke, _super);
        function Ke() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.VM = new qe;
            return _this;
        }
        Ke.prototype.Rb = function (t, i, n) { return __assign(__assign({}, this.fS(t, i, n)), n.Sh(t)); };
        Ke.prototype.NM = function () { var t = this.ae.N(); this.VM.ht({ Un: this.kM, ml: this.le.Bt().ml(), dS: t.openVisible, cS: t.thinBars, lt: this.TM }); };
        return Ke;
    }(Ye));
    var Ge = { type: "Bar", isBuiltIn: !0, defaultOptions: { upColor: "#26a69a", downColor: "#ef5350", openVisible: !0, thinBars: !0 }, mb: function (t, i) { return new Ke(t, i); } };
    var Ze = /** @class */ (function (_super) {
        __extends(Ze, _super);
        function Ze() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.qt = null, _this.oS = 0;
            return _this;
        }
        Ze.prototype.ht = function (t) { this.qt = t; };
        Ze.prototype.et = function (t) { if (null === this.qt || 0 === this.qt.Un.length || null === this.qt.lt)
            return; var i = t.horizontalPixelRatio; if (this.oS = function (t, i) { if (t >= 2.5 && t <= 4)
            return Math.floor(3 * i); var n = 1 - .2 * Math.atan(Math.max(4, t) - 4) / (.5 * Math.PI), s = Math.floor(t * n * i), e = Math.floor(t * i), r = Math.min(s, e); return Math.max(Math.floor(i), r); }(this.qt.ml, i), this.oS >= 2) {
            Math.floor(i) % 2 != this.oS % 2 && this.oS--;
        } var n = this.qt.Un; this.qt.pS && this.vS(t, n, this.qt.lt), this.qt.Mi && this.Vm(t, n, this.qt.lt); var s = this.mS(i); (!this.qt.Mi || this.oS > 2 * s) && this.wS(t, n, this.qt.lt); };
        Ze.prototype.vS = function (t, i, n) { if (null === this.qt)
            return; var s = t.context, e = t.horizontalPixelRatio, r = t.verticalPixelRatio; var h = "", a = Math.min(Math.floor(e), Math.floor(this.qt.ml * e)); a = Math.max(Math.floor(e), Math.min(a, this.oS)); var l = Math.floor(.5 * a); var o = null; for (var t_93 = n.from; t_93 < n.to; t_93++) {
            var n_74 = i[t_93];
            n_74.rh !== h && (s.fillStyle = n_74.rh, h = n_74.rh);
            var _10 = Math.round(Math.min(n_74.i_, n_74.e_) * r), u_12 = Math.round(Math.max(n_74.i_, n_74.e_) * r), c_7 = Math.round(n_74.n_ * r), d_5 = Math.round(n_74.s_ * r);
            var f_6 = Math.round(e * n_74._t) - l;
            var p_5 = f_6 + a - 1;
            null !== o && (f_6 = Math.max(o + 1, f_6), f_6 = Math.min(f_6, p_5));
            var v_4 = p_5 - f_6 + 1;
            s.fillRect(f_6, c_7, v_4, _10 - c_7), s.fillRect(f_6, u_12 + 1, v_4, d_5 - u_12), o = p_5;
        } };
        Ze.prototype.mS = function (t) { var i = Math.floor(1 * t); this.oS <= 2 * i && (i = Math.floor(.5 * (this.oS - 1))); var n = Math.max(Math.floor(t), i); return this.oS <= 2 * n ? Math.max(Math.floor(t), Math.floor(1 * t)) : n; };
        Ze.prototype.Vm = function (t, i, n) { if (null === this.qt)
            return; var s = t.context, e = t.horizontalPixelRatio, r = t.verticalPixelRatio; var h = ""; var a = this.mS(e); var l = null; for (var t_94 = n.from; t_94 < n.to; t_94++) {
            var n_75 = i[t_94];
            n_75.eh !== h && (s.fillStyle = n_75.eh, h = n_75.eh);
            var o_12 = Math.round(n_75._t * e) - Math.floor(.5 * this.oS);
            var _11 = o_12 + this.oS - 1, u_13 = Math.round(Math.min(n_75.i_, n_75.e_) * r), c_8 = Math.round(Math.max(n_75.i_, n_75.e_) * r);
            if (null !== l && (o_12 = Math.max(l + 1, o_12), o_12 = Math.min(o_12, _11)), this.qt.ml * e > 2 * a)
                V(s, o_12, u_13, _11 - o_12 + 1, c_8 - u_13 + 1, a);
            else {
                var t_95 = _11 - o_12 + 1;
                s.fillRect(o_12, u_13, t_95, c_8 - u_13 + 1);
            }
            l = _11;
        } };
        Ze.prototype.wS = function (t, i, n) { if (null === this.qt)
            return; var s = t.context, e = t.horizontalPixelRatio, r = t.verticalPixelRatio; var h = ""; var a = this.mS(e); for (var t_96 = n.from; t_96 < n.to; t_96++) {
            var n_76 = i[t_96];
            var l_18 = Math.round(Math.min(n_76.i_, n_76.e_) * r), o_13 = Math.round(Math.max(n_76.i_, n_76.e_) * r), _12 = Math.round(n_76._t * e) - Math.floor(.5 * this.oS), u_14 = _12 + this.oS - 1;
            if (n_76.sh !== h) {
                var t_97 = n_76.sh;
                s.fillStyle = t_97, h = t_97;
            }
            this.qt.Mi && (_12 += a, l_18 += a, u_14 -= a, o_13 -= a), l_18 > o_13 || s.fillRect(_12, l_18, u_14 - _12 + 1, o_13 - l_18 + 1);
        } };
        return Ze;
    }(y));
    var Xe = /** @class */ (function (_super) {
        __extends(Xe, _super);
        function Xe() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.VM = new Ze;
            return _this;
        }
        Xe.prototype.Rb = function (t, i, n) { return __assign(__assign({}, this.fS(t, i, n)), n.Sh(t)); };
        Xe.prototype.NM = function () { var t = this.ae.N(); this.VM.ht({ Un: this.kM, ml: this.le.Bt().ml(), pS: t.wickVisible, Mi: t.borderVisible, lt: this.TM }); };
        return Xe;
    }(Ye));
    var Je = { type: "Candlestick", isBuiltIn: !0, defaultOptions: { upColor: "#26a69a", downColor: "#ef5350", wickVisible: !0, borderVisible: !0, borderColor: "#378658", borderUpColor: "#26a69a", borderDownColor: "#ef5350", wickColor: "#737375", wickUpColor: "#26a69a", wickDownColor: "#ef5350" }, mb: function (t, i) { return new Xe(t, i); } };
    var Qe = /** @class */ (function (_super) {
        __extends(Qe, _super);
        function Qe() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.qt = null, _this.gS = [];
            return _this;
        }
        Qe.prototype.ht = function (t) { this.qt = t, this.gS = []; };
        Qe.prototype.et = function (_j) {
            var t = _j.context, i = _j.horizontalPixelRatio, n = _j.verticalPixelRatio;
            if (null === this.qt || 0 === this.qt.ot.length || null === this.qt.lt)
                return;
            this.gS.length || this.MS(i);
            var s = Math.max(1, Math.floor(n)), e = Math.round(this.qt.bS * n) - Math.floor(s / 2), r = e + s;
            for (var i_89 = this.qt.lt.from; i_89 < this.qt.lt.to; i_89++) {
                var h_18 = this.qt.ot[i_89], a_19 = this.gS[i_89 - this.qt.lt.from], l_19 = Math.round(h_18.ut * n);
                var o_14 = void 0, _13 = void 0;
                t.fillStyle = h_18.sh, l_19 <= e ? (o_14 = l_19, _13 = r) : (o_14 = e, _13 = l_19 - Math.floor(s / 2) + s), t.fillRect(a_19.Na, o_14, a_19.bi - a_19.Na + 1, _13 - o_14);
            }
        };
        Qe.prototype.MS = function (t) { if (null === this.qt || 0 === this.qt.ot.length || null === this.qt.lt)
            return void (this.gS = []); var i = Math.ceil(this.qt.ml * t) <= 1 ? 0 : Math.max(1, Math.floor(t)), n = Math.round(this.qt.ml * t) - i; this.gS = new Array(this.qt.lt.to - this.qt.lt.from); for (var i_90 = this.qt.lt.from; i_90 < this.qt.lt.to; i_90++) {
            var s_53 = this.qt.ot[i_90], e_37 = Math.round(s_53._t * t);
            var r_26 = void 0, h_19 = void 0;
            if (n % 2) {
                var t_98 = (n - 1) / 2;
                r_26 = e_37 - t_98, h_19 = e_37 + t_98;
            }
            else {
                var t_99 = n / 2;
                r_26 = e_37 - t_99, h_19 = e_37 + t_99 - 1;
            }
            this.gS[i_90 - this.qt.lt.from] = { Na: r_26, bi: h_19, SS: e_37, ce: s_53._t * t, wt: s_53.wt };
        } for (var t_100 = this.qt.lt.from + 1; t_100 < this.qt.lt.to; t_100++) {
            var n_77 = this.gS[t_100 - this.qt.lt.from], s_54 = this.gS[t_100 - this.qt.lt.from - 1];
            n_77.wt === s_54.wt + 1 && (n_77.Na - s_54.bi !== i + 1 && (s_54.SS > s_54.ce ? s_54.bi = n_77.Na - i - 1 : n_77.Na = s_54.bi + i + 1));
        } var s = Math.ceil(this.qt.ml * t); for (var t_101 = this.qt.lt.from; t_101 < this.qt.lt.to; t_101++) {
            var i_91 = this.gS[t_101 - this.qt.lt.from];
            i_91.bi < i_91.Na && (i_91.bi = i_91.Na);
            var n_78 = i_91.bi - i_91.Na + 1;
            s = Math.min(n_78, s);
        } if (i > 0 && s < 4)
            for (var t_102 = this.qt.lt.from; t_102 < this.qt.lt.to; t_102++) {
                var i_92 = this.gS[t_102 - this.qt.lt.from];
                i_92.bi - i_92.Na + 1 > s && (i_92.SS > i_92.ce ? i_92.bi -= 1 : i_92.Na += 1);
            } };
        return Qe;
    }(y));
    var tr = /** @class */ (function (_super) {
        __extends(tr, _super);
        function tr() {
            var _this = this;
            _this = _super.apply(this, arguments) || this, _this.VM = new Qe;
            return _this;
        }
        tr.prototype.EM = function (t, i) { var n = this.ae.Ft().Nt(this.ae.N().base, a(this.ae.zt()).Wt); return null === n ? null : Rs(this.kM, this.TM, t, i, this.le.Bt().ml(), this.ae.N().hitTestTolerance, (function (t, i) { i[0] = t.ut, i[1] = n; })); };
        tr.prototype.Rb = function (t, i, n) { return __assign(__assign({}, this.Tb(t, i)), n.Sh(t)); };
        tr.prototype.NM = function () { var t = { ot: this.kM, ml: this.le.Bt().ml(), lt: this.TM, bS: this.ae.Ft().Nt(this.ae.N().base, a(this.ae.zt()).Wt) }; this.VM.ht(t); };
        return tr;
    }(xe));
    var ir = { type: "Histogram", isBuiltIn: !0, defaultOptions: { color: "#26a69a", base: 0 }, mb: function (t, i) { return new tr(t, i); } };
    var nr = /** @class */ (function () {
        function nr(t, i) {
            this.yt = t, this.xS = i, this.CS();
        }
        nr.prototype.detach = function () { this.yt.detachPrimitive(this.xS); };
        nr.prototype.getPane = function () { return this.yt; };
        nr.prototype.applyOptions = function (t) { var _j, _k; (_k = (_j = this.xS).vr) === null || _k === void 0 ? void 0 : _k.call(_j, t); };
        nr.prototype.CS = function () { this.yt.attachPrimitive(this.xS); };
        return nr;
    }());
    var sr = { visible: !0, horzAlign: "center", vertAlign: "center", lines: [] }, er = { color: "rgba(0, 0, 0, 0.5)", fontSize: 48, fontFamily: w, fontStyle: "", text: "" };
    var rr = /** @class */ (function () {
        function rr(t) {
            this.yS = new Map, this.qt = t;
        }
        rr.prototype.draw = function (t) {
            var _this = this;
            t.useMediaCoordinateSpace((function (t) { if (!_this.qt.visible)
                return; var i = t.context, n = t.mediaSize; var s = 0; for (var _j = 0, _k = _this.qt.lines; _j < _k.length; _j++) {
                var t_103 = _k[_j];
                if (0 === t_103.text.length)
                    continue;
                i.font = t_103.k;
                var e_38 = _this.PS(i, t_103.text);
                e_38 > n.width ? t_103.Uc = n.width / e_38 : t_103.Uc = 1, s += t_103.lineHeight * t_103.Uc;
            } var e = 0; switch (_this.qt.vertAlign) {
                case "top":
                    e = 0;
                    break;
                case "center":
                    e = Math.max((n.height - s) / 2, 0);
                    break;
                case "bottom": e = Math.max(n.height - s, 0);
            } for (var _q = 0, _y = _this.qt.lines; _q < _y.length; _q++) {
                var t_104 = _y[_q];
                i.save(), i.fillStyle = t_104.color;
                var s_55 = 0;
                switch (_this.qt.horzAlign) {
                    case "left":
                        i.textAlign = "left", s_55 = t_104.lineHeight / 2;
                        break;
                    case "center":
                        i.textAlign = "center", s_55 = n.width / 2;
                        break;
                    case "right": i.textAlign = "right", s_55 = n.width - 1 - t_104.lineHeight / 2;
                }
                i.translate(s_55, e), i.textBaseline = "top", i.font = t_104.k, i.scale(t_104.Uc, t_104.Uc), i.fillText(t_104.text, 0, t_104.kS), i.restore(), e += t_104.lineHeight * t_104.Uc;
            } }));
        };
        rr.prototype.PS = function (t, i) { var n = this.TS(t.font); var s = n.get(i); return void 0 === s && (s = t.measureText(i).width, n.set(i, s)), s; };
        rr.prototype.TS = function (t) { var i = this.yS.get(t); return void 0 === i && (i = new Map, this.yS.set(t, i)), i; };
        return rr;
    }());
    var hr = /** @class */ (function () {
        function hr(t) {
            this.yn = lr(t);
        }
        hr.prototype.Pt = function (t) { this.yn = lr(t); };
        hr.prototype.renderer = function () { return new rr(this.yn); };
        return hr;
    }());
    function ar(t) { return __assign(__assign({}, t), { k: g(t.fontSize, t.fontFamily, t.fontStyle), lineHeight: t.lineHeight || 1.2 * t.fontSize, kS: 0, Uc: 0 }); }
    function lr(t) { return __assign(__assign({}, t), { lines: t.lines.map(ar) }); }
    function or(t) { return __assign(__assign({}, er), t); }
    function _r(t) { var _j, _k; return __assign(__assign(__assign({}, sr), t), { lines: (_k = (_j = t.lines) === null || _j === void 0 ? void 0 : _j.map(or)) !== null && _k !== void 0 ? _k : [] }); }
    var ur = /** @class */ (function () {
        function ur(t) {
            this.yn = _r(t), this.RS = [new hr(this.yn)];
        }
        ur.prototype.updateAllViews = function () {
            var _this = this;
            this.RS.forEach((function (t) { return t.Pt(_this.yn); }));
        };
        ur.prototype.paneViews = function () { return this.RS; };
        ur.prototype.attached = function (_j) {
            var t = _j.requestUpdate;
            this.DS = t;
        };
        ur.prototype.detached = function () { this.DS = void 0; };
        ur.prototype.vr = function (t) { this.yn = _r(__assign(__assign({}, this.yn), t)), this.DS && this.DS(); };
        return ur;
    }());
    var cr = { alpha: 1, padding: 0 };
    var dr = /** @class */ (function () {
        function dr(t) {
            this.qt = t;
        }
        dr.prototype.draw = function (t) {
            var _this = this;
            t.useMediaCoordinateSpace((function (t) { var _j; var i = t.context, n = _this.IS(_this.qt, t.mediaSize); n && _this.qt.VS && (i.globalAlpha = (_j = _this.qt.alpha) !== null && _j !== void 0 ? _j : 1, i.drawImage(_this.qt.VS, n._t, n.ut, n.nn, n.$t)); }));
        };
        dr.prototype.IS = function (t, i) { var n = t.maxHeight, s = t.maxWidth, e = t.ES, r = t.BS, h = t.padding, a = Math.round(i.width / 2), l = Math.round(i.height / 2), o = h !== null && h !== void 0 ? h : 0; var _ = i.width - 2 * o, u = i.height - 2 * o; n && (u = Math.min(u, n)), s && (_ = Math.min(_, s)); var c = _ / r, d = u / e, f = Math.min(c, d), p = r * f, v = e * f; return { _t: a - .5 * p, ut: l - .5 * v, $t: v, nn: p }; };
        return dr;
    }());
    var fr = /** @class */ (function () {
        function fr(t) {
            this.AS = null, this.zS = 0, this.LS = 0, this.yn = t, this.M = pr(this.yn, this.AS, this.zS, this.LS);
        }
        fr.prototype.OS = function (t) { void 0 !== t.NS && (this.zS = t.NS), void 0 !== t.FS && (this.LS = t.FS), void 0 !== t.WS && (this.AS = t.WS), this.Pt(); };
        fr.prototype.HS = function (t) { this.yn = t, this.Pt(); };
        fr.prototype.zOrder = function () { return "bottom"; };
        fr.prototype.Pt = function () { this.M = pr(this.yn, this.AS, this.zS, this.LS); };
        fr.prototype.renderer = function () { return new dr(this.M); };
        return fr;
    }());
    function pr(t, i, n, s) { return __assign(__assign({}, t), { VS: i, BS: n, ES: s }); }
    function vr(t) { return __assign(__assign({}, cr), t); }
    var mr = /** @class */ (function () {
        function mr(t, i) {
            this.US = null, this.$S = t, this.yn = vr(i), this.RS = [new fr(this.yn)];
        }
        mr.prototype.updateAllViews = function () { this.RS.forEach((function (t) { return t.Pt(); })); };
        mr.prototype.paneViews = function () { return this.RS; };
        mr.prototype.attached = function (t) {
            var _this = this;
            var i = t.requestUpdate;
            this.jS = i, this.US = new Image, this.US.onload = function () { var _j, _k, _q, _y; var t = (_k = (_j = _this.US) === null || _j === void 0 ? void 0 : _j.naturalHeight) !== null && _k !== void 0 ? _k : 1, i = (_y = (_q = _this.US) === null || _q === void 0 ? void 0 : _q.naturalWidth) !== null && _y !== void 0 ? _y : 1; _this.RS.forEach((function (n) { return n.OS({ FS: t, NS: i, WS: _this.US }); })), _this.jS && _this.jS(); }, this.US.src = this.$S;
        };
        mr.prototype.detached = function () { this.jS = void 0, this.US = null; };
        mr.prototype.vr = function (t) { this.yn = vr(__assign(__assign({}, this.yn), t)), this.qS(), this.DS && this.DS(); };
        mr.prototype.DS = function () { this.jS && this.jS(); };
        mr.prototype.qS = function () {
            var _this = this;
            this.RS.forEach((function (t) { return t.HS(_this.yn); }));
        };
        return mr;
    }());
    var wr = /** @class */ (function () {
        function wr(t, i) {
            this.ae = t, this.Jh = i, this.CS();
        }
        wr.prototype.detach = function () { this.ae.detachPrimitive(this.Jh); };
        wr.prototype.getSeries = function () { return this.ae; };
        wr.prototype.applyOptions = function (t) { this.Jh && this.Jh.vr && this.Jh.vr(t); };
        wr.prototype.CS = function () { this.ae.attachPrimitive(this.Jh); };
        return wr;
    }());
    var gr = { autoScale: !0, zOrder: "normal" };
    function Mr(t, i) { return ti(Math.min(Math.max(t, 12), 30) * i); }
    function br(t, i) { var n = "circle" === t ? .8 : "square" === t ? .7 : 1; return ti(Math.max(i, 12) * n); }
    function Sr(t) { return function (t) { var i = Math.ceil(t); return i % 2 != 0 ? i - 1 : i; }(Mr(t, 1)); }
    function xr(t) { return Math.max(Mr(t, .1), 3); }
    function Cr(t, i, n) { return i ? t : n ? Math.ceil(t / 2) : 0; }
    function yr(t, i, n, s) { var e = (br("arrowUp", s) - 1) / 2 * n.YS, r = (ti(s / 2) - 1) / 2 * n.YS; i.beginPath(), t ? (i.moveTo(n._t - e, n.ut), i.lineTo(n._t, n.ut - e), i.lineTo(n._t + e, n.ut), i.lineTo(n._t + r, n.ut), i.lineTo(n._t + r, n.ut + e), i.lineTo(n._t - r, n.ut + e), i.lineTo(n._t - r, n.ut)) : (i.moveTo(n._t - e, n.ut), i.lineTo(n._t, n.ut + e), i.lineTo(n._t + e, n.ut), i.lineTo(n._t + r, n.ut), i.lineTo(n._t + r, n.ut - e), i.lineTo(n._t - r, n.ut - e), i.lineTo(n._t - r, n.ut)), i.fill(); }
    function Pr(t, i, n, s, e, r) { var h = (br("arrowUp", s) - 1) / 2, a = (ti(s / 2) - 1) / 2; if (e >= i - a - 2 && e <= i + a + 2 && r >= (t ? n : n - h) - 2 && r <= (t ? n + h : n) + 2)
        return !0; return (function () { if (e < i - h - 3 || e > i + h + 3 || r < (t ? n - h - 3 : n) || r > (t ? n : n + h + 3))
        return !1; var s = Math.abs(e - i); return Math.abs(r - n) + 3 >= s / 2; })(); }
    var kr = /** @class */ (function () {
        function kr() {
            this.qt = null, this.$s = new it, this.F = -1, this.W = "", this.hm = "", this.KS = "normal";
        }
        kr.prototype.ht = function (t) { this.qt = t; };
        kr.prototype.js = function (t, i, n) { this.F === t && this.W === i || (this.F = t, this.W = i, this.hm = g(t, i), this.$s.Os()), this.KS = n; };
        kr.prototype.Qs = function (t, i) { var _j; if (null === this.qt || null === this.qt.lt)
            return null; for (var n_79 = this.qt.lt.from; n_79 < this.qt.lt.to; n_79++) {
            var s_56 = this.qt.ot[n_79];
            if (s_56 && Rr(s_56, t, i))
                return { zOrder: "normal", externalId: (_j = s_56.te) !== null && _j !== void 0 ? _j : "", itemType: "marker" };
        } return null; };
        kr.prototype.draw = function (t) {
            var _this = this;
            "aboveSeries" !== this.KS && t.useBitmapCoordinateSpace((function (t) { _this.et(t); }));
        };
        kr.prototype.drawBackground = function (t) {
            var _this = this;
            "aboveSeries" === this.KS && t.useBitmapCoordinateSpace((function (t) { _this.et(t); }));
        };
        kr.prototype.et = function (_j) {
            var t = _j.context, i = _j.horizontalPixelRatio, n = _j.verticalPixelRatio;
            if (null !== this.qt && null !== this.qt.lt) {
                t.textBaseline = "middle", t.font = this.hm;
                for (var s_57 = this.qt.lt.from; s_57 < this.qt.lt.to; s_57++) {
                    var e_39 = this.qt.ot[s_57];
                    void 0 !== e_39.ri && (e_39.ri.nn = this.$s.Ii(t, e_39.ri.GS), e_39.ri.$t = this.F, e_39.ri._t = e_39._t - e_39.ri.nn / 2), Tr(e_39, t, i, n);
                }
            }
        };
        return kr;
    }());
    function Tr(t, i, n, s) { i.fillStyle = t.R, void 0 !== t.ri && function (t, i, n, s, e, r) { t.save(), t.scale(e, r), t.fillText(i, n, s), t.restore(); }(i, t.ri.GS, t.ri._t, t.ri.ut, n, s), function (t, i, n) { if (0 === t.Th)
        return; switch (t.ZS) {
        case "arrowDown": return void yr(!1, i, n, t.Th);
        case "arrowUp": return void yr(!0, i, n, t.Th);
        case "circle": return void function (t, i, n) { var s = (br("circle", n) - 1) / 2; t.beginPath(), t.arc(i._t, i.ut, s * i.YS, 0, 2 * Math.PI, !1), t.fill(); }(i, n, t.Th);
        case "square": return void function (t, i, n) { var s = br("square", n), e = (s - 1) * i.YS / 2, r = i._t - e, h = i.ut - e; t.fillRect(r, h, s * i.YS, s * i.YS); }(i, n, t.Th);
    } t.ZS; }(t, i, function (t, i, n) { var s = Math.max(1, Math.floor(i)) % 2 / 2; return { _t: Math.round(t._t * i) + s, ut: t.ut * n, YS: i }; }(t, n, s)); }
    function Rr(t, i, n) { return !(void 0 === t.ri || !function (t, i, n, s, e, r) { var h = s / 2; return e >= t && e <= t + n && r >= i - h && r <= i + h; }(t.ri._t, t.ri.ut, t.ri.nn, t.ri.$t, i, n)) || function (t, i, n) { if (0 === t.Th)
        return !1; switch (t.ZS) {
        case "arrowDown": return Pr(!0, t._t, t.ut, t.Th, i, n);
        case "arrowUp": return Pr(!1, t._t, t.ut, t.Th, i, n);
        case "circle": return function (t, i, n, s, e) { var r = 2 + br("circle", n) / 2, h = t - s, a = i - e; return Math.sqrt(h * h + a * a) <= r; }(t._t, t.ut, t.Th, i, n);
        case "square": return function (t, i, n, s, e) { var r = br("square", n), h = (r - 1) / 2, a = t - h, l = i - h; return s >= a && s <= a + r && e >= l && e <= l + r; }(t._t, t.ut, t.Th, i, n);
    } }(t, i, n); }
    function Dr(t) { return "atPriceTop" === t || "atPriceBottom" === t || "atPriceMiddle" === t; }
    function Ir(t, i, n, s, e, r, h, l) { var o = function (t, i, n) { if (Dr(i.position) && void 0 !== i.price)
        return i.price; if ("value" in (s = t) && "number" == typeof s.value)
        return t.value; var s; if (function (t) { return "open" in t && "high" in t && "low" in t && "close" in t; }(t)) {
        if ("inBar" === i.position)
            return t.close;
        if ("aboveBar" === i.position)
            return n ? t.low : t.high;
        if ("belowBar" === i.position)
            return n ? t.high : t.low;
    } }(n, i, h.priceScale().options().invertScale); if (void 0 === o)
        return; var _ = Dr(i.position), c = l.timeScale(), d = u(i.size) ? Math.max(i.size, 0) : 1, f = Sr(c.options().barSpacing) * d, p = f / 2; t.Th = f; switch (i.position) {
        case "inBar":
        case "atPriceMiddle": return t.ut = a(h.priceToCoordinate(o)), void (void 0 !== t.ri && (t.ri.ut = t.ut + p + r + .6 * e));
        case "aboveBar":
        case "atPriceTop": {
            var i_93 = _ ? 0 : s.XS;
            return t.ut = a(h.priceToCoordinate(o)) - p - i_93, void 0 !== t.ri && (t.ri.ut = t.ut - p - .6 * e, s.XS += 1.2 * e), void (_ || (s.XS += f + r));
        }
        case "belowBar":
        case "atPriceBottom": {
            var i_94 = _ ? 0 : s.JS;
            return t.ut = a(h.priceToCoordinate(o)) + p + i_94, void 0 !== t.ri && (t.ri.ut = t.ut + p + r + .6 * e, s.JS += 1.2 * e), void (_ || (s.JS += f + r));
        }
    } }
    var Vr = /** @class */ (function () {
        function Vr(t, i, n) {
            this.QS = [], this.xt = !0, this.tx = !0, this.Xt = new kr, this.Te = t, this.Gv = i, this.qt = { ot: [], lt: null }, this.yn = n;
        }
        Vr.prototype.renderer = function () { if (!this.Te.options().visible)
            return null; this.xt && this.IM(); var t = this.Gv.options().layout; return this.Xt.js(t.fontSize, t.fontFamily, this.yn.zOrder), this.Xt.ht(this.qt), this.Xt; };
        Vr.prototype.ix = function (t) { this.QS = t, this.Pt("data"); };
        Vr.prototype.Pt = function (t) { this.xt = !0, "data" === t && (this.tx = !0); };
        Vr.prototype.nx = function (t) { this.xt = !0, this.yn = t; };
        Vr.prototype.zOrder = function () { return "aboveSeries" === this.yn.zOrder ? "top" : this.yn.zOrder; };
        Vr.prototype.IM = function () { var t = this.Gv.timeScale(), i = this.QS; this.tx && (this.qt.ot = i.map((function (t) { return ({ wt: t.time, _t: 0, ut: 0, Th: 0, ZS: t.shape, R: t.color, te: t.id, sx: t.sx, ri: void 0 }); })), this.tx = !1); var n = this.Gv.options().layout; this.qt.lt = null; var s = t.getVisibleLogicalRange(); if (null === s)
            return; var e = new Ii(Math.floor(s.from), Math.ceil(s.to)); if (null === this.Te.dataByIndex(0, 1))
            return; if (0 === this.qt.ot.length)
            return; var r = NaN; var h = xr(t.options().barSpacing), l = { XS: h, JS: h }; this.qt.lt = Vs(this.qt.ot, e, !0); for (var s_58 = this.qt.lt.from; s_58 < this.qt.lt.to; s_58++) {
            var e_40 = i[s_58];
            e_40.time !== r && (l.XS = h, l.JS = h, r = e_40.time);
            var o_15 = this.qt.ot[s_58];
            o_15._t = a(t.logicalToCoordinate(e_40.time)), void 0 !== e_40.text && e_40.text.length > 0 && (o_15.ri = { GS: e_40.text, _t: 0, ut: 0, nn: 0, $t: 0 });
            var _14 = this.Te.dataByIndex(e_40.time, 0);
            null !== _14 && Ir(o_15, e_40, _14, l, n.fontSize, h, this.Te, this.Gv);
        } this.xt = !1; };
        return Vr;
    }());
    function Er(t) { return __assign(__assign({}, gr), t); }
    var Br = /** @class */ (function () {
        function Br(t) {
            this.Yh = null, this.QS = [], this.hx = [], this.lx = null, this.Te = null, this.Gv = null, this.ox = !0, this._x = null, this.ux = null, this.vx = null, this.mx = !0, this.yn = Er(t);
        }
        Br.prototype.attached = function (t) {
            var _this = this;
            this.wx(), this.Gv = t.chart, this.Te = t.series, this.Yh = new Vr(this.Te, a(this.Gv), this.yn), this.jS = t.requestUpdate, this.Te.subscribeDataChanged((function (t) { return _this.QM(t); })), this.mx = !0, this.DS();
        };
        Br.prototype.DS = function () { this.jS && this.jS(); };
        Br.prototype.detached = function () { this.Te && this.lx && this.Te.unsubscribeDataChanged(this.lx), this.Gv = null, this.Te = null, this.Yh = null, this.lx = null; };
        Br.prototype.ix = function (t) { this.mx = !0, this.QS = t, this.wx(), this.ox = !0, this.ux = null, this.DS(); };
        Br.prototype.gx = function () { return this.QS; };
        Br.prototype.paneViews = function () { return this.Yh ? [this.Yh] : []; };
        Br.prototype.updateAllViews = function () { this.Mx(); };
        Br.prototype.hitTest = function (t, i) { var _j, _k; return this.Yh ? (_k = (_j = this.Yh.renderer()) === null || _j === void 0 ? void 0 : _j.Qs(t, i)) !== null && _k !== void 0 ? _k : null : null; };
        Br.prototype.autoscaleInfo = function (t, i) { if (this.yn.autoScale && this.Yh) {
            var t_105 = this.bx();
            if (t_105)
                return { priceRange: null, margins: t_105 };
        } return null; };
        Br.prototype.vr = function (t) { this.yn = Er(__assign(__assign({}, this.yn), t)), this.DS && this.DS(); };
        Br.prototype.bx = function () { var t = a(this.Gv).timeScale().options().barSpacing; if (this.ox || t !== this.vx) {
            if (this.vx = t, this.QS.length > 0) {
                var i_95 = xr(t), n_80 = 1.5 * Sr(t) + 2 * i_95, s_59 = this.Sx();
                this._x = { above: Cr(n_80, s_59.aboveBar, s_59.inBar), below: Cr(n_80, s_59.belowBar, s_59.inBar) };
            }
            else
                this._x = null;
            this.ox = !1;
        } return this._x; };
        Br.prototype.Sx = function () { return null === this.ux && (this.ux = this.QS.reduce((function (t, i) { return (t[i.position] || (t[i.position] = !0), t); }), { inBar: !1, aboveBar: !1, belowBar: !1, atPriceTop: !1, atPriceBottom: !1, atPriceMiddle: !1 })), this.ux; };
        Br.prototype.wx = function () {
            var _this = this;
            var _j;
            if (!this.mx || !this.Gv || !this.Te)
                return;
            var t = this.Gv.timeScale(), i = (_j = this.Te) === null || _j === void 0 ? void 0 : _j.data();
            if (null == t.getVisibleLogicalRange() || !this.Te || 0 === i.length)
                return void (this.hx = []);
            var n = t.timeToIndex(a(i[0].time), !0);
            this.hx = this.QS.map((function (i, s) { var e = t.timeToIndex(i.time, !0), r = e < n ? 1 : -1, h = a(_this.Te).dataByIndex(e, r), l = { time: t.timeToIndex(a(h).time, !1), position: i.position, shape: i.shape, color: i.color, id: i.id, sx: s, text: i.text, size: i.size, price: i.price, Qr: i.time }; if ("atPriceTop" === i.position || "atPriceBottom" === i.position || "atPriceMiddle" === i.position) {
                if (void 0 === i.price)
                    throw new Error("Price is required for position ".concat(i.position));
                return __assign(__assign({}, l), { position: i.position, price: i.price });
            } return __assign(__assign({}, l), { position: i.position, price: i.price }); })), this.mx = !1;
        };
        Br.prototype.Mx = function (t) { this.Yh && (this.wx(), this.Yh.ix(this.hx), this.Yh.nx(this.yn), this.Yh.Pt(t)); };
        Br.prototype.QM = function (t) { this.mx = !0, this.DS(); };
        return Br;
    }());
    var Ar = /** @class */ (function (_super) {
        __extends(Ar, _super);
        function Ar(t, i, n) {
            var _this = this;
            _this = _super.call(this, t, i) || this, n && _this.setMarkers(n);
            return _this;
        }
        Ar.prototype.setMarkers = function (t) { this.Jh.ix(t); };
        Ar.prototype.markers = function () { return this.Jh.gx(); };
        return Ar;
    }(wr));
    var zr = /** @class */ (function () {
        function zr(t) {
            this.QS = new Map, this.xx = t;
        }
        zr.prototype.Cx = function (t, i, n) {
            var _this = this;
            if (this.yx(i), void 0 !== n) {
                var s_60 = window.setTimeout((function () { _this.QS.delete(i), _this.Px(); }), n), e_41 = __assign(__assign({}, t), { kx: s_60, Tx: Date.now() + n });
                this.QS.set(i, e_41);
            }
            else
                this.QS.set(i, __assign(__assign({}, t), { kx: void 0, Tx: void 0 }));
            this.Px();
        };
        zr.prototype.yx = function (t) { var i = this.QS.get(t); i && void 0 !== i.kx && window.clearTimeout(i.kx), this.QS.delete(t), this.Px(); };
        zr.prototype.Rx = function () { for (var _j = 0, _k = this.QS; _j < _k.length; _j++) {
            var t_106 = _k[_j][0];
            this.yx(t_106);
        } };
        zr.prototype.Dx = function () { var t = Date.now(), i = []; for (var _j = 0, _k = this.QS; _j < _k.length; _j++) {
            var _q = _k[_j], n_81 = _q[0], s_61 = _q[1];
            !s_61.Tx || s_61.Tx > t ? i.push({ time: s_61.time, sign: s_61.sign, value: s_61.value }) : this.yx(n_81);
        } return i; };
        zr.prototype.Ix = function (t) { this.xx = t; };
        zr.prototype.Px = function () { this.xx && this.xx(); };
        return zr;
    }());
    var Lr = { positiveColor: "#22AB94", negativeColor: "#F7525F", updateVisibilityDuration: 5e3 };
    var Or = /** @class */ (function () {
        function Or(t, i, n, s) {
            this.qt = t, this.Vx = i, this.Ex = n, this.Bx = s;
        }
        Or.prototype.draw = function (t) {
            var _this = this;
            t.useBitmapCoordinateSpace((function (t) { var i = t.context, n = Math.max(1, Math.floor(t.horizontalPixelRatio)) % 2 / 2, s = 4 * t.verticalPixelRatio + n; _this.qt.forEach((function (e) { var r = Math.round(e._t * t.horizontalPixelRatio) + n; i.beginPath(); var h = _this.Ax(e.zx); i.fillStyle = h, i.arc(r, e.ut * t.verticalPixelRatio, s, 0, 2 * Math.PI, !1), i.fill(), e.zx && (i.strokeStyle = h, i.lineWidth = Math.floor(2 * t.horizontalPixelRatio), i.beginPath(), i.moveTo((e._t - 4.7) * t.horizontalPixelRatio + n, (e.ut - 7 * e.zx) * t.verticalPixelRatio), i.lineTo(e._t * t.horizontalPixelRatio + n, (e.ut - 7 * e.zx - 7 * e.zx * .5) * t.verticalPixelRatio), i.lineTo((e._t + 4.7) * t.horizontalPixelRatio + n, (e.ut - 7 * e.zx) * t.verticalPixelRatio), i.stroke()); })); }));
        };
        Or.prototype.Ax = function (t) { return 0 === t ? this.Vx : t > 0 ? this.Bx : this.Ex; };
        return Or;
    }());
    var Nr = /** @class */ (function () {
        function Nr(t, i, n) {
            this.qt = [], this.Te = t, this.ia = i, this.yn = n;
        }
        Nr.prototype.Pt = function (t) {
            var _this = this;
            this.qt = t.map((function (t) { var i = _this.Te.priceToCoordinate(t.value); if (null === i)
                return null; return { _t: a(_this.ia.timeToCoordinate(t.time)), ut: i, zx: t.sign }; })).filter(v);
        };
        Nr.prototype.renderer = function () { var t = function (t, i) { return function (t, i) { return "Area" === i; }(0, i) ? t.lineColor : t.color; }(this.Te.options(), this.Te.seriesType()); return new Or(this.qt, t, this.yn.negativeColor, this.yn.positiveColor); };
        return Nr;
    }());
    function Fr(t, i) { return "Line" === i || "Area" === i; }
    var Wr = /** @class */ (function () {
        function Wr(t) {
            var _this = this;
            this.Gv = void 0, this.Te = void 0, this.RS = [], this.Pu = null, this.Lx = new Map, this.Ox = new zr((function () { return _this.DS(); })), this.yn = __assign(__assign({}, Lr), t);
        }
        Wr.prototype.vr = function (t) { this.yn = __assign(__assign({}, this.yn), t), this.DS(); };
        Wr.prototype.ix = function (t) {
            var _this = this;
            this.Ox.Rx();
            var i = this.Pu;
            i && t.forEach((function (t) { _this.Ox.Cx(t, i.key(t.time)); }));
        };
        Wr.prototype.gx = function () { return this.Ox.Dx(); };
        Wr.prototype.DS = function () { var _j; (_j = this.jS) === null || _j === void 0 ? void 0 : _j.call(this); };
        Wr.prototype.attached = function (t) { var i = t.chart, n = t.series, s = t.requestUpdate, e = t.horzScaleBehavior; this.Gv = i, this.Te = n, this.Pu = e; var r = this.Te.seriesType(); if ("Area" !== r && "Line" !== r)
            throw new Error("UpDownMarkersPrimitive is only supported for Area and Line series types"); this.RS = [new Nr(this.Te, this.Gv.timeScale(), this.yn)], this.jS = s, this.DS(); };
        Wr.prototype.detached = function () { this.Gv = void 0, this.Te = void 0, this.jS = void 0; };
        Wr.prototype._m = function () { return h(this.Gv); };
        Wr.prototype.Y_ = function () { return h(this.Te); };
        Wr.prototype.updateAllViews = function () {
            var _this = this;
            this.RS.forEach((function (t) { return t.Pt(_this.gx()); }));
        };
        Wr.prototype.paneViews = function () { return this.RS; };
        Wr.prototype.ht = function (t) {
            var _this = this;
            if (!this.Te)
                throw new Error("Primitive not attached to series");
            var i = this.Te.seriesType();
            this.Lx.clear();
            var n = this.Pu;
            n && t.forEach((function (t) { ss(t) && Fr(0, i) && _this.Lx.set(n.key(t.time), t.value); })), h(this.Te).setData(t);
        };
        Wr.prototype.Pt = function (t, i) { if (!this.Te || !this.Pu)
            throw new Error("Primitive not attached to series"); var n = this.Te.seriesType(), s = this.Pu.key(t.time); if (ns(t) && this.Lx.delete(s), ss(t) && Fr(0, n)) {
            var i_96 = this.Lx.get(s);
            i_96 && this.Ox.Cx({ time: t.time, value: t.value, sign: Hr(t.value, i_96) }, s, this.yn.updateVisibilityDuration);
        } h(this.Te).update(t, i); };
        Wr.prototype.Nx = function () { this.Ox.Rx(); };
        return Wr;
    }());
    function Hr(t, i) { return t === i ? 0 : t - i > 0 ? 1 : -1; }
    var Ur = /** @class */ (function (_super) {
        __extends(Ur, _super);
        function Ur() {
            return _super !== null && _super.apply(this, arguments) || this;
        }
        Ur.prototype.setData = function (t) { return this.Jh.ht(t); };
        Ur.prototype.update = function (t, i) { return this.Jh.Pt(t, i); };
        Ur.prototype.markers = function () { return this.Jh.gx(); };
        Ur.prototype.setMarkers = function (t) { return this.Jh.ix(t); };
        Ur.prototype.clearMarkers = function () { return this.Jh.Nx(); };
        return Ur;
    }(wr));
    var $r = __assign(__assign({}, t), { color: "#2196f3" });
    var jr = Object.freeze({ __proto__: null, AreaSeries: je, BarSeries: Ge, BaselineSeries: He, CandlestickSeries: Je, get ColorType() { return Fi; }, get CrosshairMode() { return $; }, HistogramSeries: ir, get LastPriceAnimationMode() { return Oi; }, LineSeries: Pe, get LineStyle() { return n; }, get LineType() { return i; }, get MismatchDirection() { return kt; }, get PriceLineSource() { return Ni; }, get PriceScaleMode() { return mi; }, get TickMarkType() { return Wi; }, get TrackingModeExitMode() { return Li; }, createChart: function (t, i) { return _e(t, new ln, ln.Tf(i)); }, createChartEx: _e, createImageWatermark: function (t, i, n) { return new nr(t, new mr(i, n)); }, createOptionsChart: function (t, i) { return _e(t, new Ee, i); }, createSeriesMarkers: function (t, i, n) { var s = new Ar(t, new Br(n !== null && n !== void 0 ? n : {})); return i && s.setMarkers(i), s; }, createTextWatermark: function (t, i) { return new nr(t, new ur(i)); }, createUpDownMarkers: function (t, i) {
            if (i === void 0) { i = {}; }
            return new Ur(t, new Wr(i));
        }, createYieldCurveChart: function (t, i) { var n = oe(t); return new Ie(n, i); }, customSeriesDefaultOptions: $r, defaultHorzScaleBehavior: function () { return ln; }, isBusinessDay: $i, isUTCTimestamp: ji, version: function () { return "5.2.1"; } });
    window.LightweightCharts = jr;
}();
