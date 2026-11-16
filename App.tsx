import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, BarChart3, Bell, Bike, BookOpen, Boxes, BriefcaseBusiness, CalendarDays, ChefHat, ChevronDown, CircleDollarSign, ClipboardList, Grid2X2, LayoutDashboard, LogOut, Menu, Package, Plus, Printer, Search, Settings, ShoppingBag, ShoppingCart, Sparkles, Table2, Users, Wallet, X } from 'lucide-react';
import { categories, demoAuditLogs, demoCustomers, demoEmployees, demoInventory, demoOrders, demoProducts, demoSuppliers } from './data/demoData';
import { type CartItem, type Customer, type Employee, type InventoryItem, type Order, type OrderStatus, type PaymentMethod, type Product, type Supplier } from './types';

const currency = (amount: number) => `SAR ${amount.toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (amount: number) => Math.round(amount * 100) / 100;
const localDate = (date = new Date()) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const safeRead = <T,>(key: string, initial: T): T => {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : initial; } catch { return initial; }
};
const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be disabled or full; app remains usable for this session. */ } };
const moduleGroups = [
  { title: 'Workspace', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }, { id: 'pos', label: 'POS / Billing', icon: ShoppingCart }, { id: 'orders', label: 'Orders', icon: ClipboardList }, { id: 'kitchen', label: 'Kitchen Display', icon: ChefHat }, { id: 'tables', label: 'Tables Management', icon: Table2 }, { id: 'reservations', label: 'Reservations', icon: CalendarDays }] },
  { title: 'Restaurant', items: [{ id: 'customers', label: 'Customers', icon: Users }, { id: 'menu', label: 'Menu Management', icon: BookOpen }, { id: 'categories', label: 'Categories', icon: Grid2X2 }, { id: 'inventory', label: 'Inventory', icon: Boxes }, { id: 'recipes', label: 'Recipes & Ingredients', icon: Package }, { id: 'suppliers', label: 'Suppliers', icon: BriefcaseBusiness }, { id: 'purchases', label: 'Purchase Management', icon: ShoppingBag }, { id: 'delivery', label: 'Delivery Management', icon: Bike }] },
  { title: 'Finance & team', items: [{ id: 'expenses', label: 'Expenses', icon: Wallet }, { id: 'employees', label: 'Employee Management', icon: Users }, { id: 'attendance', label: 'Attendance', icon: CalendarDays }, { id: 'payroll', label: 'Salary & Payroll', icon: CircleDollarSign }, { id: 'accounting', label: 'Accounting', icon: BarChart3 }, { id: 'reports', label: 'Sales Reports', icon: BarChart3 }, { id: 'profit', label: 'Profit & Loss', icon: Activity },  { id: 'discounts', label: 'Discounts & Coupons', icon: Sparkles }] },
  { title: 'Channels & setup', items: [{ id: 'qr', label: 'QR Menu', icon: Grid2X2 }, { id: 'settings', label: 'Settings', icon: Settings }, { id: 'roles', label: 'User Roles & Permissions', icon: Users }] }
];
const workflow: OrderStatus[] = ['Pending', 'Accepted', 'Preparing', 'Ready', 'Completed'];

type ExpenseRecord = { id: string; date: string; category: string; description: string; amount: number; paymentMethod: PaymentMethod; createdAt: string };
type PurchaseRecord = { id: string; date: string; supplierId: string; supplierName: string; inventoryId: string; itemName: string; quantity: number; unit: string; unitCost: number; total: number; paid: number; paymentStatus: 'Paid' | 'Part-paid' | 'Credit'; paymentMethod?: PaymentMethod; createdAt: string };
type PayrollPayment = { id: string; amount: number; paymentMethod: PaymentMethod; date: string; createdAt: string };
type PayrollRecord = { id: string; employeeId: string; employeeName: string; period: string; baseSalary: number; bonus: number; advanceDeduction: number; otherDeduction?: number; deductionNote?: string; netSalary: number; payments: PayrollPayment[]; createdAt: string };

function App() {
  const [view, setView] = useState('dashboard');
  const [reportRange, setReportRange] = useState('This month');
  const [products, setProducts] = useState<Product[]>(() => safeRead('musafir-products', demoProducts));
  const [inventory, setInventory] = useState<InventoryItem[]>(() => safeRead('musafir-inventory', demoInventory));
  const [customers, setCustomers] = useState<Customer[]>(() => safeRead('musafir-customers', demoCustomers));
  const [orders, setOrders] = useState<Order[]>(() => safeRead('musafir-orders', demoOrders));
  const [cart, setCart] = useState<CartItem[]>(() => safeRead('musafir-cart', []));
  const [employees, setEmployees] = useState(() => safeRead('musafir-employees', demoEmployees));
  const [suppliers, setSuppliers] = useState(() => safeRead('musafir-suppliers', demoSuppliers));
  const [expenses, setExpenses] = useState<ExpenseRecord[]>(() => safeRead('musafir-expenses', []));
  const [purchases, setPurchases] = useState<PurchaseRecord[]>(() => safeRead<PurchaseRecord[]>('musafir-purchases', []).map(item => ({ ...item, paid: Number(item.paid ?? (item.paymentStatus === 'Paid' ? item.total : 0)) })));
  const [payroll, setPayroll] = useState<PayrollRecord[]>(() => safeRead('musafir-payroll', []));
  const [attendanceDate, setAttendanceDate] = useState(() => localDate());
  const [attendanceRows, setAttendanceRows] = useState<{ employeeId: string; name: string; role: string; shift: string; status: Employee['status'] }[]>([]);
  const [logs, setLogs] = useState(() => safeRead('musafir-audit', demoAuditLogs));
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [orderType, setOrderType] = useState<Order['type']>('Dine-in');
  const [payMethod, setPayMethod] = useState<PaymentMethod>('Cash');
  const [discount, setDiscount] = useState('0');
  const [note, setNote] = useState('');
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [light, setLight] = useState(false);
  const [apiBase, setApiBase] = useState(() => safeRead('musafir-api-base', import.meta.env.VITE_API_URL || ''));
  const [apiEmail, setApiEmail] = useState('');
  const [apiPassword, setApiPassword] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [apiBranchId, setApiBranchId] = useState('');
  const [apiRole, setApiRole] = useState('');
  const [apiConnected, setApiConnected] = useState(false);
  const [apiBusy, setApiBusy] = useState(false);
  const [apiMessage, setApiMessage] = useState('');
  const [backupMessage, setBackupMessage] = useState('');
  const backupInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { save('musafir-products', products); }, [products]);
  useEffect(() => { save('musafir-inventory', inventory); }, [inventory]);
  useEffect(() => { save('musafir-customers', customers); }, [customers]);
  useEffect(() => { save('musafir-orders', orders); }, [orders]);
  useEffect(() => { save('musafir-cart', cart); }, [cart]);
  useEffect(() => { if (!apiConnected) save('musafir-employees', employees); }, [employees, apiConnected]);
  useEffect(() => { save('musafir-suppliers', suppliers); }, [suppliers]);
  useEffect(() => { save('musafir-expenses', expenses); }, [expenses]);
  useEffect(() => { save('musafir-purchases', purchases); }, [purchases]);
  useEffect(() => { if (!apiConnected) save('musafir-payroll', payroll); }, [payroll, apiConnected]);
  // Connected mode keeps salary data on the server only: never leave it in this browser's local storage.
  useEffect(() => { if (!apiConnected) return; try { localStorage.removeItem('musafir-employees'); localStorage.removeItem('musafir-payroll'); } catch { /* Storage can be disabled. */ } }, [apiConnected]);
  const hrRole = apiConnected ? apiRole : 'owner';
  const canManageHr = ['owner', 'manager'].includes(hrRole);
  const canViewPayroll = ['owner', 'manager', 'accountant'].includes(hrRole);
  useEffect(() => {
    if (!apiConnected || !apiToken || view !== 'attendance' || !canManageHr) return;
    let active = true;
    const loadAttendance = async () => {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/attendance?date=${encodeURIComponent(attendanceDate)}`, { headers: { Authorization: `Bearer ${apiToken}` } });
        const data = await response.json();
        if (active && response.ok && Array.isArray(data.attendance)) setAttendanceRows(data.attendance.map((row: { employeeId: string; name: string; role: string; shift: string; status: Employee['status'] | null }) => ({ employeeId: row.employeeId, name: row.name, role: row.role, shift: row.shift, status: row.status || 'Not marked' })));
      } catch { /* Keep the last rows during a temporary network failure. */ }
    };
    void loadAttendance();
    return () => { active = false; };
  }, [apiConnected, apiToken, apiBase, view, attendanceDate, canManageHr, employees.length]);
  useEffect(() => { save('musafir-audit', logs); }, [logs]);

  useEffect(() => {
    if (!apiConnected || !apiToken || !apiBranchId) return;
    let active = true;
    const refreshLiveData = async () => {
      try {
        const headers = { Authorization: `Bearer ${apiToken}` };
        const [ordersResponse, inventoryResponse, expensesResponse, purchasesResponse, suppliersResponse, employeesResponse, payrollResponse] = await Promise.all([
          fetch(`${apiBase.replace(/\/$/, '')}/api/orders?limit=150`, { headers }),
          fetch(`${apiBase.replace(/\/$/, '')}/api/inventory`, { headers }),
          fetch(`${apiBase.replace(/\/$/, '')}/api/expenses`, { headers }),
          fetch(`${apiBase.replace(/\/$/, '')}/api/purchases`, { headers }),
          fetch(`${apiBase.replace(/\/$/, '')}/api/suppliers`, { headers }),
          fetch(`${apiBase.replace(/\/$/, '')}/api/employees?date=${localDate()}`, { headers }),
          fetch(`${apiBase.replace(/\/$/, '')}/api/payroll`, { headers })
        ]);
        if (employeesResponse.ok) {
          const employeeData = await employeesResponse.json();
          if (active && Array.isArray(employeeData.employees)) setEmployees(employeeData.employees.map((item: {
            id:string;name:string;role:string;shift:string;status:Employee['status'];salary:string|number;advance:string|number;
          }) => ({id:item.id,name:item.name,role:item.role,shift:item.shift,status:item.status,salary:Number(item.salary),advance:Number(item.advance)})));
        }
        if (payrollResponse.ok) {
          const payrollData = await payrollResponse.json();
          if (active && Array.isArray(payrollData.payroll)) setPayroll(payrollData.payroll.map((item: {
            id:string;employeeId:string;employeeName:string;period:string;baseSalary:string|number;bonus:string|number;
            advanceDeduction:string|number;otherDeduction?:string|number;deductionNote?:string;netSalary:string|number;createdAt:string;
            payments:Array<{id:string;amount:string|number;paymentMethod:'Cash'|'Mada';date:string;createdAt:string}>;
          }) => ({
            id:item.id,employeeId:item.employeeId,employeeName:item.employeeName,period:item.period,
            baseSalary:Number(item.baseSalary),bonus:Number(item.bonus),advanceDeduction:Number(item.advanceDeduction),otherDeduction:Number(item.otherDeduction||0),deductionNote:item.deductionNote||'',
            netSalary:Number(item.netSalary),createdAt:item.createdAt,
            payments:item.payments.map(payment=>({id:payment.id,amount:Number(payment.amount),paymentMethod:payment.paymentMethod,date:payment.date,createdAt:payment.createdAt}))
          })));
        }
        if (!ordersResponse.ok || !inventoryResponse.ok) return;
        const [orderData, inventoryData] = await Promise.all([ordersResponse.json(), inventoryResponse.json()]);
        if (!active || !Array.isArray(orderData.orders) || !Array.isArray(inventoryData.items)) return;
        if (expensesResponse.ok) {
          const expenseData = await expensesResponse.json();
          if (active && Array.isArray(expenseData.expenses)) setExpenses(expenseData.expenses.map((item: {id:string;date:string;category:string;description:string;amount:string|number;paymentMethod:string;createdAt:string}) => ({
            id:item.id,date:item.date,category:item.category,description:item.description,amount:Number(item.amount),
            paymentMethod:item.paymentMethod === 'Mada' ? 'Mada' : 'Cash',createdAt:item.createdAt
          })));
        }
        if (purchasesResponse.ok) {
          const purchaseData = await purchasesResponse.json();
          if (active && Array.isArray(purchaseData.purchases)) setPurchases(purchaseData.purchases.map((item: {
            id:string;created_at:string;supplier_id:string;supplier_name:string;ingredient_id:string;item_name:string;quantity:string|number;unit:string;
            unit_cost:string|number;total:string|number;paid:string|number;payment_method?:string;
          }) => {
            const amount = Number(item.total);
            const paidAmount = Number(item.paid);
            return {
              id:item.id,date:String(item.created_at).slice(0,10),supplierId:item.supplier_id,supplierName:item.supplier_name,
              inventoryId:item.ingredient_id,itemName:item.item_name,quantity:Number(item.quantity),unit:item.unit,
              unitCost:Number(item.unit_cost),total:amount,paid:paidAmount,
              paymentStatus:paidAmount >= amount ? 'Paid' : paidAmount > 0 ? 'Part-paid' : 'Credit',
              paymentMethod:item.payment_method === 'Mada' ? 'Mada' : paidAmount > 0 ? 'Cash' : undefined,createdAt:item.created_at
            } as PurchaseRecord;
          }));
        }
        if (suppliersResponse.ok) {
          const supplierData = await suppliersResponse.json();
          if (active && Array.isArray(supplierData.suppliers)) setSuppliers(supplierData.suppliers.map((item: {
            id:string;name:string;phone?:string;category?:string;payable:string|number;
          }) => ({id:item.id,name:item.name,phone:item.phone || '',category:item.category || 'General',due:Number(item.payable)})));
        }
        const liveOrders: Order[] = orderData.orders.map((saved: {
          id: string; order_number: number | string; order_type: Order['type']; status: string;
          created_at: string; customer_name: string; subtotal: string | number; tax: string | number;
          discount: string | number; total: string | number; paid: string | number;
          payment_method: string; notes?: string;
          items: Array<{ id: string; productId: string | null; name: string; qty: number; unitPrice: string | number }>;
        }) => ({
          id: saved.id,
          number: String(saved.order_number),
          type: saved.order_type,
          status: saved.status as OrderStatus,
          createdAt: saved.created_at,
          customerName: saved.customer_name,
          subtotal: Number(saved.subtotal),
          tax: Number(saved.tax),
          discount: Number(saved.discount),
          total: Number(saved.total),
          paid: Number(saved.paid),
          paymentMethod: saved.payment_method === 'Mada' ? 'Mada' : 'Cash',
          kitchenNote: saved.notes || undefined,
          items: saved.items.map(item => ({
            id: item.id,
            productId: item.productId || '',
            name: item.name,
            qty: Number(item.qty),
            unitPrice: Number(item.unitPrice)
          }))
        }));
        setOrders(current => [
          ...current.filter(order => order.number === 'HOLD'),
          ...liveOrders
        ]);
        setInventory(inventoryData.items.map((item: {
          id: string; name: string; category?: string; unit: string;
          stock: string | number; trackStock?: boolean; reorderLevel: string | number; unitCost: string | number;
          supplier?: string; expiresOn?: string | null;
        }) => ({
          id: item.id,
          name: item.name,
          category: item.category || 'General',
          unit: item.unit,
          stock: Number(item.stock),
          trackStock: Boolean(item.trackStock),
          reorderLevel: Number(item.reorderLevel),
          cost: Number(item.unitCost),
          supplier: item.supplier || '—',
          expiry: item.expiresOn || ''
        })));
      } catch {
        // Keep the last confirmed server snapshot during temporary network failures.
      }
    };
    void refreshLiveData();
    const interval = window.setInterval(() => { void refreshLiveData(); }, 15000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [apiBase, apiToken, apiBranchId, apiConnected]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 2800); return () => window.clearTimeout(timer); }, [toast]);

  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const tax = subtotal * 0.15;
  const discountAmount = (subtotal + tax) * Math.max(0, Math.min(100, Number(discount) || 0)) / 100;
  const total = Math.max(0, subtotal + tax - discountAmount);
  const paid = total;
  const filteredProducts = useMemo(() => products.filter(p => (category === 'All' || p.category === category) && p.name.toLowerCase().includes(search.toLowerCase())), [products, category, search]);
  const lowStock = inventory.filter(item => item.trackStock && item.stock <= item.reorderLevel);
  const todayOrders = orders.filter(order => new Date(order.createdAt).toDateString() === new Date().toDateString() && order.number !== 'HOLD');
  const salesToday = todayOrders.reduce((sum, order) => sum + order.total, 0);
  const week = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (6 - index));
    const amount = orders.filter(order => order.number !== 'HOLD' && new Date(order.createdAt).toDateString() === date.toDateString()).reduce((sum, order) => sum + order.total, 0);
    return { day: date.toLocaleDateString('en', { weekday: 'short' }), amount };
  });
  const maxWeek = Math.max(1, ...week.map(item => item.amount));
  const topProducts = [...orders.filter(order => order.number !== 'HOLD').flatMap(order => order.items)].reduce<{name:string; qty:number}[]>((list, item) => {
    const found = list.find(entry => entry.name === item.name); if (found) found.qty += item.qty; else list.push({ name: item.name, qty: item.qty }); return list;
  }, []).sort((a,b) => b.qty - a.qty).slice(0,4);

  const flash = (message: string) => setToast(message);
  const nextNumber = () => { const next = Math.max(1000, ...orders.map(order => Number(order.number) || 0)) + 1; return String(next); };
  const addToCart = (product: Product) => {
    setCart(current => { const exists = current.find(item => item.productId === product.id); return exists ? current.map(item => item.productId === product.id ? { ...item, qty: item.qty + 1 } : item) : [...current, { id: `${product.id}-${Date.now()}`, productId: product.id, name: product.name, price: product.price, qty: 1 }]; });
  };
  const clearCart = () => { setCart([]); setDiscount('0'); setNote(''); };
  const placeOrder = async () => {
    if (!cart.length) { flash('Add at least one menu item first.'); return; }
    if (apiToken && apiBranchId) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
          body: JSON.stringify({
            orderType,
            paymentMethod: payMethod,
            discount: discountAmount,
            taxRate: 0.15,
            notes: note,
            items: cart.map(item => ({ productId: item.productId, quantity: item.qty }))
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Order could not be saved to the server.');
        const saved = result.order;
        const serverTotal = Number(saved.total);
        const order: Order = {
          id: saved.id,
          number: String(saved.order_number),
          type: orderType,
          status: saved.status || 'Pending',
          createdAt: saved.created_at || new Date().toISOString(),
          customerName: 'Walk-in Guest',
          items: cart.map(item => ({ id: item.id, productId: item.productId, name: item.name, qty: item.qty, unitPrice: item.price, note: note || undefined })),
          subtotal: Number(saved.subtotal),
          tax: Number(saved.tax),
          discount: Number(saved.discount),
          total: serverTotal,
          paid: serverTotal,
          paymentMethod: payMethod,
          kitchenNote: note || undefined
        };
        setOrders(current => [order, ...current]);
        setLogs(current => [{ id: `log-${Date.now()}`, title: 'Server sale completed', detail: `Order #${order.number} · ${currency(serverTotal)} · ${payMethod}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
        clearCart(); setView('orders'); flash(`Order #${order.number} saved to the database.`);
      } catch (error) {
        flash(error instanceof Error ? error.message : 'Backend connection failed. Order was not submitted.');
      }
      return;
    }
    const deductions = new Map<string, number>();
    cart.forEach(item => products.find(product => product.id === item.productId)?.recipe.forEach(ingredient => {
      const key = ingredient.name.trim().toLowerCase();
      deductions.set(key, (deductions.get(key) || 0) + ingredient.qty * item.qty);
    }));
    const shortages = inventory.filter(item => {
      const required = deductions.get(item.name.trim().toLowerCase()) || 0;
      return item.trackStock && required > item.stock;
    });
    if (shortages.length) {
      flash(`Insufficient stock: ${shortages.map(item => item.name).join(', ')}. Receive stock before checkout.`);
      return;
    }
    const number = nextNumber();
    const order: Order = { id: `o-${number}`, number, type: orderType, status: 'Pending', createdAt: new Date().toISOString(), customerName: 'Walk-in Guest', items: cart.map(item => ({ id: item.id, productId: item.productId, name: item.name, qty: item.qty, unitPrice: item.price, note: note || undefined })), subtotal, tax, discount: discountAmount, total, paid: total, paymentMethod: payMethod, kitchenNote: note || undefined };
    setInventory(current => current.map(item => {
      const amount = deductions.get(item.name.trim().toLowerCase()) || 0;
      return amount && item.trackStock ? { ...item, stock: item.stock - amount } : item;
    }));
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const stockLogs = inventory.flatMap(item => {
      const amount = deductions.get(item.name.trim().toLowerCase()) || 0;
      return amount && item.trackStock ? [{ id: `consume-${number}-${item.id}`, title: 'Stock consumed', detail: `Order #${number} · ${item.name} · -${amount} ${item.unit}`, time }] : [];
    });
    setOrders(current => [order, ...current]);
    setLogs(current => [
      { id: `log-${Date.now()}`, title: 'Sale completed', detail: `Order #${number} · ${currency(total)} · ${payMethod}`, time },
      ...stockLogs,
      ...current
    ]);
    clearCart(); setView('orders'); flash(`Order #${number} placed successfully (offline demo).`);
  };
  const connectBackend = async () => {
    const base = apiBase.trim().replace(/\/$/, '');
    if (!base || !apiEmail.trim() || !apiPassword) { setApiMessage('API URL, email and password are required.'); return; }
    setApiBusy(true); setApiMessage('');
    try {
      const loginResponse = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: apiEmail.trim(), password: apiPassword })
      });
      const login = await loginResponse.json();
      if (!loginResponse.ok) throw new Error(login.error || 'Login failed.');
      const branchId = login.user?.branchId;
      if (!login.token || !branchId) throw new Error('Login response did not include a branch session.');
      const authHeaders = { Authorization: `Bearer ${login.token}` };
      const [menuResponse, ordersResponse, inventoryResponse, suppliersResponse, purchasesResponse] = await Promise.all([
        fetch(`${base}/api/menu?branchId=${encodeURIComponent(branchId)}`),
        fetch(`${base}/api/orders?limit=150`, { headers: authHeaders }),
        fetch(`${base}/api/inventory`, { headers: authHeaders }),
        fetch(`${base}/api/suppliers`, { headers: authHeaders }),
        fetch(`${base}/api/purchases`, { headers: authHeaders })
      ]);
      const [menu, orderData, inventoryData, supplierData, purchaseData] = await Promise.all([menuResponse.json(), ordersResponse.json(), inventoryResponse.json(), suppliersResponse.json(), purchasesResponse.json()]);
      if (!menuResponse.ok || !Array.isArray(menu.products) || !menu.products.length) throw new Error(menu.error || 'No active menu products were returned for this branch.');
      if (!ordersResponse.ok || !Array.isArray(orderData.orders)) throw new Error(orderData.error || 'Could not load branch order history.');
      if (!inventoryResponse.ok || !Array.isArray(inventoryData.items)) throw new Error(inventoryData.error || 'Could not load branch inventory.');
      if (!suppliersResponse.ok || !Array.isArray(supplierData.suppliers)) throw new Error(supplierData.error || 'Could not load branch suppliers.');
      if (!purchasesResponse.ok || !Array.isArray(purchaseData.purchases)) throw new Error(purchaseData.error || 'Could not load branch purchase history.');
      setInventory(inventoryData.items.map((item: {id:string;name:string;category?:string;unit:string;stock:string|number;trackStock?:boolean;reorderLevel:string|number;unitCost:string|number;supplier?:string;expiresOn?:string|null})=>({id:item.id,name:item.name,category:item.category||'General',unit:item.unit,stock:Number(item.stock),trackStock:Boolean(item.trackStock),reorderLevel:Number(item.reorderLevel),cost:Number(item.unitCost),supplier:item.supplier||'—',expiry:item.expiresOn||''})));
      setSuppliers(supplierData.suppliers.map((supplier: {id:string;name:string;phone?:string;category?:string;payable:string|number})=>({id:supplier.id,name:supplier.name,phone:supplier.phone||'',category:supplier.category||'General',due:Number(supplier.payable)})));
      setPurchases(purchaseData.purchases.filter((purchase: {ingredient_id?:string;item_name?:string})=>purchase.ingredient_id && purchase.item_name).map((purchase: {id:string;created_at:string;supplier_id:string;supplier_name:string;ingredient_id:string;item_name:string;unit:string;quantity:string|number;unit_cost:string|number;total:string|number;paid:string|number;payment_method:string})=>({id:purchase.id,date:purchase.created_at.slice(0,10),supplierId:purchase.supplier_id,supplierName:purchase.supplier_name,inventoryId:purchase.ingredient_id,itemName:purchase.item_name,quantity:Number(purchase.quantity),unit:purchase.unit,unitCost:Number(purchase.unit_cost),total:Number(purchase.total),paid:Number(purchase.paid),paymentStatus:Number(purchase.paid)>=Number(purchase.total)?'Paid':Number(purchase.paid)>0?'Part-paid':'Credit',paymentMethod:purchase.payment_method as PaymentMethod,createdAt:purchase.created_at})));
      setOrders(orderData.orders.map((saved: { id:string; order_number:number|string; order_type:Order['type']; status:string; created_at:string; customer_name:string; subtotal:string|number; tax:string|number; discount:string|number; total:string|number; paid:string|number; payment_method:string; notes?:string; items:Array<{id:string;productId:string|null;name:string;qty:number;unitPrice:string|number}> }) => ({
        id: saved.id,
        number: String(saved.order_number),
        type: saved.order_type,
        status: saved.status as OrderStatus,
        createdAt: saved.created_at,
        customerName: saved.customer_name,
        subtotal: Number(saved.subtotal),
        tax: Number(saved.tax),
        discount: Number(saved.discount),
        total: Number(saved.total),
        paid: Number(saved.paid),
        paymentMethod: saved.payment_method === 'Mada' ? 'Mada' : 'Cash',
        kitchenNote: saved.notes || undefined,
        items: saved.items.map(item => ({ id:item.id, productId:item.productId || '', name:item.name, qty:Number(item.qty), unitPrice:Number(item.unitPrice) }))
      })));
      setProducts(menu.products.map((item: { id:string; name:string; category?:string; price:string|number; image_url?:string }) => ({
        id: item.id,
        name: item.name,
        category: (item.category || 'Snacks') as Product['category'],
        price: Number(item.price),
        image: item.image_url || '',
        popularity: 0,
        recipe: []
      })));
      setApiBase(base); save('musafir-api-base', base);
      setEmployees([]); setPayroll([]); setAttendanceRows([]);
      setApiRole(String(login.user?.role || '')); setApiToken(login.token); setApiBranchId(branchId); setApiConnected(true);
      setApiPassword('');
      setApiMessage(`Connected to branch ${branchId}. ${menu.products.length} menu products, ${orderData.orders.length} orders and ${inventoryData.items.length} inventory items loaded.`);
    } catch (error) {
      setApiToken(''); setApiBranchId(''); setApiConnected(false); setApiRole('');
      setApiMessage(error instanceof Error ? error.message : 'Could not connect to backend.');
    } finally { setApiBusy(false); }
  };
  const disconnectBackend = () => {
    setApiToken(''); setApiBranchId(''); setApiConnected(false); setApiRole(''); setProducts(demoProducts); setEmployees(demoEmployees); setPayroll([]); setAttendanceRows([]);
    setApiMessage('Disconnected. POS is using local demo data.');
  };
  const exportBackup = () => {
    const backup = {
      app: 'Musafir Fast Food POS',
      formatVersion: 4,
      exportedAt: new Date().toISOString(),
      data: { products, inventory, customers, orders, cart, employees, suppliers, expenses, purchases, payroll, logs }
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `musafir-pos-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setBackupMessage('Backup file generated. Keep a copy outside this device.');
  };
  const importBackup = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const data = parsed?.data;
      const required = ['products', 'inventory', 'customers', 'orders', 'cart', 'employees', 'suppliers', 'logs'];
      if (parsed?.app !== 'Musafir Fast Food POS' || ![1, 2, 3, 4].includes(parsed?.formatVersion) || !data || required.some(key => !Array.isArray(data[key])) || (data.expenses !== undefined && !Array.isArray(data.expenses)) || (data.purchases !== undefined && !Array.isArray(data.purchases)) || (data.payroll !== undefined && !Array.isArray(data.payroll))) {
        throw new Error('This is not a valid Musafir POS backup file.');
      }
      if (!window.confirm('Restore this backup? Current POS data on this device will be replaced.')) return;
      setProducts(data.products);
      setInventory(data.inventory);
      setCustomers(data.customers);
      setOrders(data.orders);
      setCart(data.cart);
      setEmployees(data.employees);
      setSuppliers(data.suppliers);
      setExpenses(Array.isArray(data.expenses) ? data.expenses : []);
      setPurchases(Array.isArray(data.purchases) ? data.purchases.map((item: PurchaseRecord) => ({ ...item, paid: Number(item.paid ?? (item.paymentStatus === 'Paid' ? item.total : 0)) })) : []);
      setPayroll(Array.isArray(data.payroll) ? data.payroll : []);
      setLogs(data.logs);
      setBackupMessage('Backup restored on this device.');
    } catch (error) {
      setBackupMessage(error instanceof Error ? error.message : 'Backup could not be restored.');
    } finally {
      if (backupInputRef.current) backupInputRef.current.value = '';
    }
  };

  const apiSettings = (): ReactNode => <div className="space-y-4"><section className={`${panel} max-w-2xl p-5 md:p-7`}>
    <div className="mb-5">{heading('Local data protection','POS backup & restore','Export or restore this device’s saved POS records. Restore replaces the current local data.')}</div>
    <div className="flex flex-wrap gap-2">
      <button onClick={exportBackup} className="rounded-xl bg-[#e7b943] px-4 py-2.5 text-sm font-semibold text-[#17130b]">Export backup</button>
      <button onClick={() => backupInputRef.current?.click()} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300">Restore backup</button>
      <input ref={backupInputRef} type="file" accept="application/json,.json" className="hidden" onChange={event => { void importBackup(event.target.files?.[0]); }} />
    </div>
    {backupMessage && <p role="status" className="mt-3 text-xs text-slate-300">{backupMessage}</p>}
    <p className="mt-3 text-xs leading-5 text-amber-200/70">Backups contain saved orders, products, stock, customers, employees, suppliers, purchases, expenses and audit history. Store backup files securely. This does not copy data from the connected server database.</p>
  </section><section className={`${panel} max-w-2xl p-5 md:p-7`}>
    <div className="mb-5">{heading('System integration','Backend connection','Connect this POS to the live Saudi branch database.')}</div>
    <label className="mb-1 block text-xs text-slate-400">Backend API URL</label>
    <input value={apiBase} onChange={event=>setApiBase(event.target.value)} placeholder="https://your-api-service.onrender.com" className="field mb-4 w-full"/>
    <label className="mb-1 block text-xs text-slate-400">Admin email</label>
    <input type="email" value={apiEmail} onChange={event=>setApiEmail(event.target.value)} placeholder="admin@example.com" className="field mb-4 w-full"/>
    <label className="mb-1 block text-xs text-slate-400">Admin password</label>
    <input type="password" value={apiPassword} onChange={event=>setApiPassword(event.target.value)} placeholder="Enter backend admin password" className="field mb-4 w-full"/>
    <div className="flex flex-wrap gap-2">
      <button onClick={connectBackend} disabled={apiBusy} className="rounded-xl bg-[#e7b943] px-4 py-2.5 text-sm font-semibold text-[#17130b] disabled:opacity-50">{apiBusy?'Connecting…':'Connect backend'}</button>
      {apiConnected&&<button onClick={disconnectBackend} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300">Disconnect</button>}
    </div>
    <p className={`mt-4 text-xs ${apiConnected?'text-emerald-300':'text-slate-400'}`}>{apiConnected?'Connected: new checkouts are written to PostgreSQL.':'Not connected: checkout remains in local demo mode.'}</p>
    {apiMessage&&<p role="status" className="mt-2 rounded-lg bg-white/[.04] p-3 text-xs text-slate-300">{apiMessage}</p>}
    {apiConnected&&<p className="mt-3 text-[11px] text-slate-500">Branch ID: {apiBranchId}</p>}
  </section></div>;
  const holdOrder = () => {
    if (!cart.length) { flash('There is no order to hold.'); return; }
    const number = `H-${Date.now()}`;
    const order: Order = { id: number, number: 'HOLD', type: orderType, status: 'Pending', createdAt: new Date().toISOString(), customerName: 'Held order', items: cart.map(item => ({ id: `${item.id}-hold`, productId: item.productId, name: item.name, qty: item.qty, unitPrice: item.price })), subtotal, tax, discount: discountAmount, total, paid: 0, paymentMethod: payMethod, kitchenNote: note || undefined };
    setOrders(current => [order, ...current]); clearCart(); setView('orders'); flash('Order held. Resume it from the Orders list.');
  };
  const resumeOrder = (order: Order) => { setCart(order.items.map(item => ({ id: item.id, productId: item.productId, name: item.name, price: item.unitPrice, qty: item.qty }))); setOrderType(order.type); setOrders(current => current.filter(entry => entry.id !== order.id)); setView('pos'); flash('Held order restored to the cart.'); };
  const changeStatus = async (id: string) => {
    const currentOrder = orders.find(order => order.id === id);
    if (!currentOrder) return;
    const index = workflow.indexOf(currentOrder.status);
    const nextStatus = workflow[Math.min(index + 1, workflow.length - 1)];
    if (apiToken && apiConnected) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/orders/${encodeURIComponent(id)}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
          body: JSON.stringify({ status: nextStatus })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Order status could not be updated.');
      } catch (error) {
        flash(error instanceof Error ? error.message : 'Could not update order status on server.');
        return;
      }
    }
    setOrders(current => current.map(order => order.id === id ? { ...order, status: nextStatus } : order));
  };
  const addInventoryItem = async () => {
    const name = window.prompt('Stock item name');
    if (!name?.trim()) return;
    const category = window.prompt('Category', 'General') || 'General';
    const unit = window.prompt('Unit (piece, can, kg, g, litre...)', 'piece') || 'piece';
    const quantityInput = window.prompt('Initial quantity (leave blank for Unlimited)', '');
    if (quantityInput === null) return;
    const trackStock = quantityInput.trim() !== '';
    const stock = trackStock ? Number(quantityInput) : 0;
    if (trackStock && (!Number.isFinite(stock) || stock < 0)) { flash('Enter a valid stock quantity or leave it blank for Unlimited.'); return; }
    const item: InventoryItem = { id: `i-${Date.now()}`, name: name.trim(), category, unit, stock, trackStock, reorderLevel: 0, cost: 0, supplier: '—', expiry: '' };
    if (apiToken && apiConnected) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/inventory`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
          body: JSON.stringify({ sku: `POS-${Date.now()}`, name: item.name, category, unit, stock, trackStock, reorderLevel: 0, unitCost: 0 })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Stock item could not be saved.');
        item.id = result.item.id;
      } catch (error) { flash(error instanceof Error ? error.message : 'Stock item could not be saved.'); return; }
    }
    setInventory(current => [item, ...current]);
    flash(`${item.name} added as ${trackStock ? `${stock} ${unit}` : 'Unlimited'}.`);
  };
  const editInventoryItem = async (item: InventoryItem) => {
    const name = window.prompt('Stock item name', item.name)?.trim();
    if (!name) return;
    const category = window.prompt('Category', item.category);
    if (category === null) return;
    const unit = window.prompt('Unit', item.unit);
    if (!unit?.trim()) return;
    const reorderLevel = Number(window.prompt('Reorder level', String(item.reorderLevel)));
    const unitCost = Number(window.prompt('Unit cost (SAR)', String(item.cost)));
    if (!Number.isFinite(reorderLevel) || reorderLevel < 0 || !Number.isFinite(unitCost) || unitCost < 0) { flash('Enter valid reorder and unit-cost values.'); return; }
    const changes = { name, category: category.trim() || 'General', unit: unit.trim(), reorderLevel, unitCost };
    if (apiToken && apiConnected) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/inventory/${encodeURIComponent(item.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` }, body: JSON.stringify(changes) });
        const result = await response.json();
        if (!response.ok || !result.item) throw new Error(result.error || 'Inventory item could not be updated.');
        const saved = result.item;
        setInventory(current => current.map(entry => entry.id === item.id ? { ...entry, name: saved.name, category: saved.category, unit: saved.unit, stock: Number(saved.stock), trackStock: Boolean(saved.trackStock ?? saved.track_stock), reorderLevel: Number(saved.reorderLevel ?? saved.reorder_level), cost: Number(saved.unitCost ?? saved.unit_cost) } : entry));
        flash('Inventory item updated in database.');
        return;
      } catch (error) { flash(error instanceof Error ? error.message : 'Inventory update failed.'); return; }
    }
    setInventory(current => current.map(entry => entry.id === item.id ? { ...entry, ...changes } : entry));
    flash('Inventory item updated on this device only.');
  };
  const addStock = async (item: InventoryItem) => { const quantity = Number(window.prompt(`How many ${item.unit} should be added to ${item.name}?`, '10')); if (!Number.isFinite(quantity) || quantity <= 0) return; if(apiToken&&apiConnected){try{const response=await fetch(`${apiBase.replace(/\/$/,'')}/api/inventory/${encodeURIComponent(item.id)}/adjust`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiToken}`},body:JSON.stringify({quantity,note:'Stock received from POS inventory'})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Stock could not be updated.');const saved=result.item;setInventory(current=>current.map(entry=>entry.id===item.id?{...entry,stock:Number(saved.stock),trackStock:Boolean(saved.trackStock??saved.track_stock)}:entry));flash(`${item.name} stock updated in database.`);return;}catch(error){flash(error instanceof Error?error.message:'Stock update failed.');return;}}setInventory(current=>current.map(entry=>entry.id===item.id?{...entry,stock:entry.stock+quantity,trackStock:true}:entry));setLogs(current=>[{id:`stock-${Date.now()}`,title:'Stock received',detail:`${item.name} · +${quantity} ${item.unit} · Offline demo`,time:new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})},...current]);flash(`${item.name} stock updated in offline demo.`); };
  const addCustomer = () => { const name = window.prompt('Customer name'); if (!name?.trim()) return; const phone = window.prompt('Phone number') || ''; setCustomers(current => [{ id: `c-${Date.now()}`, name: name.trim(), phone, address: '', loyaltyPoints: 0, favoriteItems: [] }, ...current]); setLogs(current => [{ id: `customer-${Date.now()}`, title: 'Customer added', detail: `${name.trim()} · ${phone || 'No phone saved'}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]); flash('Customer added.'); };

  const panel = 'rounded-[24px] border border-white/[.07] bg-[#14191f] shadow-[0_18px_50px_rgba(0,0,0,.24)]';
  const heading = (eyebrow: string, title: string, subtitle?: string) => <div><p className="text-[10px] font-bold uppercase tracking-[.24em] text-[#caa348]">{eyebrow}</p><h1 className="mt-1 text-[26px] font-semibold tracking-tight text-white">{title}</h1>{subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}</div>;

  const dashboard = (): ReactNode => <div className="space-y-5">
    <section className="relative overflow-hidden rounded-[26px] border border-[#d6a943]/20 bg-[radial-gradient(ellipse_at_82%_15%,rgba(228,172,54,.22),transparent_35%),linear-gradient(115deg,#191b1d,#111519)] p-6 md:p-8">
      <div className="relative z-10 max-w-xl"><div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[#d6a943]/30 bg-[#d6a943]/10 px-3 py-1.5 text-xs text-[#f3d890]"><Sparkles size={14}/> Good Food • Good Mood</div><h1 className="text-3xl font-semibold leading-tight text-white md:text-4xl">Your restaurant,<br/><span className="text-[#e7b943]">beautifully in control.</span></h1><p className="mt-3 max-w-md text-sm leading-6 text-slate-400">A live view of sales, orders, and service for Musafir Fast Food.</p><button onClick={() => setView('pos')} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#e6b23d] px-4 py-2.5 text-sm font-semibold text-[#17130b] transition hover:bg-[#f4c75f]"><Plus size={16}/> Start a new order</button></div><div className="pointer-events-none absolute -right-10 -bottom-16 hidden h-72 w-72 rounded-full border border-[#e7b943]/15 md:block"><div className="absolute inset-8 rounded-full border border-[#e7b943]/20"/><div className="absolute inset-16 rounded-full bg-[#e7b943]/[.04]"/></div>
    </section>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[{label:'Sales today',value:currency(salesToday),icon:CircleDollarSign,sub:`${todayOrders.length} paid orders`},{label:'Orders today',value:String(todayOrders.length),icon:ClipboardList,sub:`${orders.filter(o=>o.status!=='Completed'&&o.number!=='HOLD').length} in progress`},{label:'Customers',value:String(customers.length),icon:Users,sub:'Saved customer profiles'},{label:'Low stock',value:String(lowStock.length),icon:Boxes,sub:lowStock.length?'Restock recommended':'Stock levels healthy'}].map((card,index)=><div key={card.label} className={`${panel} p-4`}><div className="flex items-center justify-between"><span className="text-sm text-slate-400">{card.label}</span><span className={`grid h-9 w-9 place-items-center rounded-xl ${index===3&&lowStock.length?'bg-rose-400/10 text-rose-300':'bg-[#e6b23d]/10 text-[#e7b943]'}`}><card.icon size={17}/></span></div><div className="mt-4 text-2xl font-semibold text-white">{card.value}</div><div className="mt-1 text-xs text-slate-500">{card.sub}</div></div>)}
    </div>
    <div className="grid gap-4 xl:grid-cols-[1.35fr_.85fr]">
      <section className={`${panel} p-5`}><div className="mb-5 flex items-center justify-between"><div><h2 className="font-semibold text-white">Sales activity</h2><p className="mt-1 text-xs text-slate-500">Actual order totals · last 7 days</p></div><span className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-400">SAR</span></div><div className="flex h-44 items-end gap-3 border-b border-l border-white/[.07] px-3 pb-0">{week.map(item=><div key={item.day} className="flex h-full flex-1 flex-col items-center justify-end gap-2"><div title={currency(item.amount)} className="w-full max-w-12 rounded-t-lg bg-gradient-to-t from-[#a9791e] to-[#f0c85c] transition-all" style={{height:`${item.amount ? Math.max(8,item.amount/maxWeek*78):3}%`}}/><span className="mb-2 text-[10px] text-slate-500">{item.day}</span></div>)}</div></section>
      <section className={`${panel} p-5`}><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold text-white">Best sellers</h2><p className="mt-1 text-xs text-slate-500">Based on recorded order items</p></div><button onClick={()=>setView('reports')} className="text-xs text-[#e7b943] hover:text-white">View report</button></div>{topProducts.length?<div className="grid grid-cols-2 gap-2">{topProducts.map((item,index)=><div key={item.name} className="min-w-0 rounded-xl border border-white/[.06] bg-white/[.025] p-3"><div className="flex items-center justify-between gap-2"><span className="grid h-7 w-7 place-items-center rounded-lg bg-[#e7b943]/10 text-[10px] font-semibold text-[#e7b943]">0{index+1}</span><span className="text-[10px] text-slate-500">{item.qty} sold</span></div><div className="mt-2 truncate text-xs font-medium text-slate-200">{item.name}</div></div>)}</div>:<p className="py-8 text-center text-sm text-slate-500">Sales data will appear here after orders are placed.</p>}</section>
    </div>
    <div className="grid gap-4 xl:grid-cols-2"><section className={`${panel} p-5`}><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold text-white">Recent orders</h2><p className="mt-1 text-xs text-slate-500">Latest sales and held checks</p></div><button onClick={()=>setView('orders')} className="text-xs text-[#e7b943]">All orders →</button></div><div className="grid grid-cols-2 gap-2">{orders.slice(0,4).map(order=><div key={order.id} className="min-w-0 rounded-xl border border-white/[.06] bg-white/[.025] p-3"><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-semibold text-slate-200">{order.number==='HOLD'?'Held order':`#${order.number}`}</span><span className="shrink-0 text-[10px] text-[#d9b752]">{order.number==='HOLD'?'Hold':order.status}</span></div><div className="mt-2 truncate text-[11px] text-slate-400">{order.customerName}</div><div className="mt-2 flex items-center justify-between gap-2"><span className="text-[10px] text-slate-500">{order.type}</span><span className="text-xs font-semibold text-white">{currency(order.total)}</span></div></div>)}</div></section><section className={`${panel} p-5`}><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold text-white">Stock watch</h2><p className="mt-1 text-xs text-slate-500">Items at or below reorder point</p></div><button onClick={()=>setView('inventory')} className="text-xs text-[#e7b943]">Inventory →</button></div>{lowStock.length?<div className="grid grid-cols-2 gap-2">{lowStock.slice(0,4).map(item=><div key={item.id} className="min-w-0 rounded-xl border border-rose-400/10 bg-rose-400/[.035] p-3"><div className="truncate text-xs font-medium text-slate-200">{item.name}</div><div className="mt-2 flex items-center justify-between gap-1"><span className="truncate text-[10px] text-slate-500">Reorder {item.reorderLevel}</span><span className="shrink-0 rounded-md bg-rose-400/10 px-2 py-1 text-[10px] text-rose-300">{item.stock} {item.unit}</span></div></div>)}</div>:<p className="py-8 text-center text-sm text-slate-500">No low-stock items.</p>}</section></div>
  </div>;

  const pos = (): ReactNode => <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_360px]"><section className={`${panel} p-4 md:p-5`}><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div>{heading('Front counter','Create an order','Choose items, then review and pay at the checkout.')}</div><div className="flex gap-1 rounded-xl bg-black/20 p-1">{(['Dine-in','Takeaway','Pickup','Home Delivery'] as Order['type'][]).map(type=><button key={type} onClick={()=>setOrderType(type)} className={`rounded-lg px-2.5 py-2 text-[11px] transition ${orderType===type?'bg-[#e7b943] font-semibold text-[#17130b]':'text-slate-400 hover:text-white'}`}>{type}</button>)}</div></div><div className="mb-4 flex gap-2"><div className="relative flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"/><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search menu..." className="field w-full pl-9"/></div><button onClick={()=>setCategory('All')} className="rounded-xl border border-white/10 px-3 text-xs text-slate-300">Reset</button></div><div className="mb-5 flex gap-2 overflow-x-auto pb-1">{['All',...categories].map(item=><button key={item} onClick={()=>setCategory(item)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${category===item?'bg-[#e7b943] font-semibold text-[#17130b]':'border border-white/10 text-slate-400 hover:border-white/20 hover:text-white'}`}>{item}</button>)}</div><div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{filteredProducts.map(product=><button key={product.id} onClick={()=>addToCart(product)} className="group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-white/[.07] bg-[#191e24] text-left transition hover:border-[#d8a93f]/50 hover:bg-[#20262c]"><div className="relative aspect-[4/3] w-full overflow-hidden bg-[#22272c]"><img src={product.image} alt={product.name} loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-105"/><span className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg bg-[#e7b943] text-[#17130b] shadow-lg"><Plus size={15}/></span></div><div className="flex min-h-[76px] w-full flex-col p-2.5"><div className="line-clamp-2 min-h-8 text-xs font-semibold leading-4 text-white">{product.name}</div><div className="mt-auto flex items-center justify-between gap-1 pt-2"><span className="truncate text-[11px] font-bold text-[#e7b943]">{currency(product.price)}</span><span className="max-w-[45%] truncate text-[9px] text-slate-500">{product.category}</span></div></div></button>)}</div>{!filteredProducts.length&&<div className="py-16 text-center text-sm text-slate-500">No menu items match this search.</div>}</section>
    <aside className={`${panel} flex flex-col p-4 md:p-5`}><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-[#caa348]">Checkout</p><h2 className="mt-1 text-lg font-semibold text-white">Current order <span className="text-sm text-slate-500">({cart.reduce((n,item)=>n+item.qty,0)})</span></h2></div><button onClick={clearCart} className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-white/5 hover:text-rose-300">Clear</button></div><div className="mt-4 max-h-[34vh] min-h-24 flex-1 space-y-2 overflow-y-auto">{cart.length?cart.map(item=><div key={item.productId} className="flex items-center gap-3 rounded-xl bg-white/[.035] p-3"><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-white">{item.name}</div><div className="mt-1 text-xs text-slate-500">{currency(item.price)} each</div></div><div className="flex items-center gap-2"><button aria-label={`Decrease ${item.name}`} onClick={()=>setCart(current=>current.map(entry=>entry.productId===item.productId?{...entry,qty:entry.qty-1}:entry).filter(entry=>entry.qty>0))} className="qty-btn">−</button><span className="w-4 text-center text-xs text-white">{item.qty}</span><button aria-label={`Increase ${item.name}`} onClick={()=>setCart(current=>current.map(entry=>entry.productId===item.productId?{...entry,qty:entry.qty+1}:entry))} className="qty-btn">+</button></div><div className="w-16 text-right text-xs font-semibold text-white">{currency(item.price*item.qty)}</div></div>):<div className="grid h-full min-h-28 place-items-center rounded-xl border border-dashed border-white/10 text-sm text-slate-600">Your order is empty</div>}</div><label className="mt-3 text-xs text-slate-400">Kitchen note</label><textarea value={note} onChange={event=>setNote(event.target.value)} rows={2} placeholder="Allergies, no onions, extra sauce…" className="field mt-1 resize-none"/><div className="mt-3 grid grid-cols-3 gap-2">{(['Cash','Mada'] as PaymentMethod[]).map(method=><button key={method} onClick={()=>setPayMethod(method)} className={`rounded-lg border py-2 text-xs ${payMethod===method?'border-[#dfb248]/50 bg-[#dfb248]/10 text-[#f0d27c]':'border-white/10 text-slate-400'}`}>{method}</button>)}</div><div className="mt-3 flex items-center justify-between text-xs text-slate-400"><span>Discount (%)</span><input aria-label="Discount percent" type="number" min="0" max="100" value={discount} onChange={event=>setDiscount(String(Math.max(0,Math.min(100,Number(event.target.value)||0))))} className="field w-20 py-1.5 text-right"/></div><div className="mt-3 space-y-2 border-t border-white/[.07] pt-3 text-sm"><div className="flex justify-between text-slate-400"><span>Subtotal</span><span>{currency(subtotal)}</span></div><div className="flex justify-between text-slate-400"><span>VAT (15%)</span><span>{currency(tax)}</span></div><div className="flex justify-between text-slate-400"><span>Discount</span><span>−{currency(discountAmount)}</span></div><div className="flex justify-between pt-1 text-lg font-semibold text-white"><span>Total</span><span className="text-[#efc75e]">{currency(total)}</span></div></div><div className="mt-4 grid grid-cols-2 gap-2"><button onClick={holdOrder} disabled={!cart.length} className="rounded-xl border border-white/10 py-2.5 text-xs text-slate-300 disabled:opacity-40">Hold order</button><button onClick={()=>window.print()} disabled={!cart.length} className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 py-2.5 text-xs text-slate-300 disabled:opacity-40"><Printer size={14}/> Print</button><button onClick={placeOrder} disabled={!cart.length} className="col-span-2 rounded-xl bg-[#e7b943] py-3 text-sm font-bold text-[#17130b] transition hover:bg-[#f4ca60] disabled:cursor-not-allowed disabled:opacity-40">{`Complete payment · ${currency(total)}`}</button></div></aside></div>;

  const ordersView = (): ReactNode => <section className={`${panel} p-5`}><div className="mb-5 flex flex-wrap items-end justify-between gap-3">{heading('Service workflow','Orders','Monitor the order lifecycle and resume checks on hold.')}</div><div className="space-y-3">{orders.map(order=><article key={order.id} className="rounded-2xl border border-white/[.07] bg-[#191e24] p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="font-semibold text-white">{order.number==='HOLD'?'Held check':`Order #${order.number}`} <span className="ml-2 text-xs font-normal text-slate-400">{order.customerName}</span></div><div className="mt-1 text-xs text-slate-500">{order.type} · {new Date(order.createdAt).toLocaleString()}</div></div><div className="flex items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-xs ${order.number==='HOLD'?'bg-amber-400/10 text-amber-300':'bg-white/[.06] text-slate-300'}`}>{order.number==='HOLD'?'On hold':order.status}</span>{order.number==='HOLD'?<button onClick={()=>resumeOrder(order)} className="rounded-lg bg-[#e7b943] px-3 py-2 text-xs font-semibold text-[#17130b]">Resume</button>:order.status!=='Completed'&&<button onClick={()=>changeStatus(order.id)} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 hover:border-[#e7b943]/40">Next status</button>}</div></div><div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-white/[.06] pt-3 text-xs text-slate-400"><span>{order.items.map(item=>`${item.qty}× ${item.name}`).join(' · ')}</span><span className="font-semibold text-[#e7b943]">{currency(order.total)} · Paid {currency(order.paid)}</span></div>{order.kitchenNote&&<p className="mt-2 text-xs text-slate-500">Kitchen note: {order.kitchenNote}</p>}</article>)}</div>{!orders.length&&<p className="py-12 text-center text-slate-500">No orders yet.</p>}</section>;
  const kitchen = (): ReactNode => <div><div className="mb-5">{heading('Live kitchen','Kitchen Display','Advance tickets here; order status is shared with the Orders screen.')}</div><div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">{workflow.slice(0,4).map(status=><section key={status} className={`${panel} min-h-64 p-4`}><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-white">{status}</h2><span className="rounded-full bg-white/[.06] px-2 py-1 text-xs text-slate-400">{orders.filter(order=>order.status===status&&order.number!=='HOLD').length}</span></div>{orders.filter(order=>order.status===status&&order.number!=='HOLD').map(order=><article key={order.id} className="mb-3 rounded-xl border border-white/[.07] bg-[#191e24] p-3"><div className="flex justify-between"><strong className="text-white">#{order.number}</strong><span className="text-xs text-slate-500">{new Date(order.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div><div className="mt-3 space-y-1 text-sm text-slate-300">{order.items.map(item=><div key={`${order.id}-${item.id}`}>{item.qty}× {item.name}</div>)}</div>{order.kitchenNote&&<p className="mt-3 rounded-lg bg-amber-300/5 p-2 text-xs text-amber-200">{order.kitchenNote}</p>}<button onClick={()=>changeStatus(order.id)} className="mt-3 w-full rounded-lg bg-[#e7b943] py-2 text-xs font-semibold text-[#17130b]">{status==='Ready'?'Complete order':`Mark ${workflow[workflow.indexOf(status)+1]}`}</button></article>)}{!orders.some(order=>order.status===status&&order.number!=='HOLD')&&<p className="py-8 text-center text-xs text-slate-600">No tickets</p>}</section>)}</div></div>;
  const inventoryView = (): ReactNode => <section className={`${panel} p-5`}><div className="mb-5 flex flex-wrap items-end justify-between gap-3">{heading('Stock control','Inventory','Items are unlimited until you enter a quantity to track.')}<button onClick={addInventoryItem} className="inline-flex items-center gap-2 rounded-xl bg-[#e7b943] px-3 py-2 text-xs font-semibold text-[#17130b]"><Plus size={14}/> Add stock item</button></div><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="text-[11px] uppercase tracking-wider text-slate-500"><tr><th className="pb-3">Ingredient</th><th className="pb-3">Category</th><th className="pb-3">On hand</th><th className="pb-3">Reorder at</th><th className="pb-3">Supplier</th><th className="pb-3">Status</th><th/></tr></thead><tbody>{inventory.map(item=><tr key={item.id} className="border-t border-white/[.06]"><td className="py-3 font-medium text-slate-200">{item.name}</td><td className="py-3 text-slate-400">{item.category}</td><td className="py-3 text-slate-300">{item.trackStock?`${item.stock} ${item.unit}`:'Unlimited'}</td><td className="py-3 text-slate-400">{item.trackStock?`${item.reorderLevel} ${item.unit}`:'—'}</td><td className="py-3 text-slate-400">{item.supplier}</td><td className="py-3"><span className={`rounded-full px-2 py-1 text-[11px] ${!item.trackStock?'bg-slate-400/10 text-slate-300':item.stock<=item.reorderLevel?'bg-rose-400/10 text-rose-300':'bg-emerald-400/10 text-emerald-300'}`}>{!item.trackStock?'Unlimited':item.stock<=item.reorderLevel?'Restock':'In stock'}</span></td><td className="py-3 text-right"><div className="flex justify-end gap-2"><button onClick={()=>editInventoryItem(item)} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300">Edit</button><button onClick={()=>addStock(item)} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:border-[#e7b943]/40">Receive stock</button></div></td></tr>)}</tbody></table></div></section>;
  const addSupplier = async () => {
    const name = window.prompt('Supplier name')?.trim();
    if (!name) return;
    const phone = (window.prompt('Supplier phone number') || '').trim();
    const category = (window.prompt('Supplier category', 'General') || 'General').trim();
    if (apiToken && apiConnected) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/suppliers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` }, body: JSON.stringify({ name, phone, category }) });
        const result = await response.json();
        if (!response.ok || !result.supplier) throw new Error(result.error || 'Supplier could not be saved.');
        const saved = result.supplier;
        setSuppliers(current => [{ id: saved.id, name: saved.name, phone: saved.phone || '', category: saved.category || 'General', due: Number(saved.payable || 0) }, ...current]);
        flash('Supplier saved to database.');
        return;
      } catch (error) { flash(error instanceof Error ? error.message : 'Supplier save failed.'); return; }
    }
    setSuppliers(current => [{ id: `local-supplier-${Date.now()}`, name, phone, category, due: 0 }, ...current]);
    flash('Supplier added to this device only. Connect the API to save across devices.');
  };
  const editSupplier = async (supplier: Supplier) => {
    const name = window.prompt('Supplier name', supplier.name);
    if (name === null || !name.trim()) return;
    const phone = window.prompt('Supplier phone number', supplier.phone);
    if (phone === null) return;
    const category = window.prompt('Supplier category', supplier.category);
    if (category === null) return;
    const changes = { name: name.trim(), phone: phone.trim(), category: category.trim() || 'General' };
    if (apiToken && apiConnected) {
      try {
        const response = await fetch(apiBase.replace(/\/$/, '') + '/api/suppliers/' + encodeURIComponent(supplier.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiToken }, body: JSON.stringify(changes) });
        const result = await response.json();
        if (!response.ok || !result.supplier) throw new Error(result.error || 'Supplier could not be updated.');
        const saved = result.supplier;
        setSuppliers(current => current.map(entry => entry.id === supplier.id ? { id: saved.id, name: saved.name, phone: saved.phone || '', category: saved.category || 'General', due: Number(saved.payable ?? entry.due) } : entry));
        flash('Supplier updated in database.');
        return;
      } catch (error) { flash(error instanceof Error ? error.message : 'Supplier update failed.'); return; }
    }
    setSuppliers(current => current.map(entry => entry.id === supplier.id ? { ...entry, ...changes } : entry));
    flash('Supplier updated on this device only.');
  };
  const paySupplier = async (supplier: Supplier) => {
    if (!apiToken || !apiConnected) { flash('Connect the POS API before recording a supplier payment.'); return; }
    if (supplier.due <= 0) { flash('This supplier has no outstanding balance.'); return; }
    const amount = Number(window.prompt(`Outstanding balance: ${currency(supplier.due)}\nPayment amount (SAR)`, String(supplier.due)));
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (amount > supplier.due) { flash('Payment cannot exceed the outstanding balance.'); return; }
    const method = (window.prompt('Payment method: Cash or Mada', 'Cash') || '').trim();
    if (!['Cash', 'Mada'].includes(method)) { flash('Choose Cash or Mada.'); return; }
    const note = (window.prompt('Payment note (optional)') || '').trim();
    let paymentSaved = false;
    try {
      const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/suppliers/${encodeURIComponent(supplier.id)}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` }, body: JSON.stringify({ amount, method, note }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Supplier payment failed.');
      paymentSaved = true;
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Supplier payment failed.');
      return;
    }
    try {
      const refresh = await fetch(`${apiBase.replace(/\/$/, '')}/api/suppliers`, { headers: { Authorization: `Bearer ${apiToken}` } });
      const data = await refresh.json();
      if (!refresh.ok || !Array.isArray(data.suppliers)) throw new Error(data.error || 'Balance refresh failed.');
      setSuppliers(data.suppliers.map((saved: {id:string;name:string;phone?:string;category?:string;payable:string|number}) => ({ id: saved.id, name: saved.name, phone: saved.phone || '', category: saved.category || 'General', due: Number(saved.payable) })));
      flash(`Supplier payment of ${currency(amount)} recorded by ${method}.`);
    } catch {
      if (paymentSaved) flash('Supplier payment was recorded. Balance refresh failed; reconnect to reload the current balance.');
    }
  };
  const addPurchase = async () => {
    if (!inventory.length || !suppliers.length) { flash('Add at least one inventory item and supplier first.'); return; }
    const itemOptions = inventory.map((item, index) => `${index + 1}. ${item.name} (${item.trackStock ? `${item.stock} ${item.unit}` : 'Unlimited'})`).join('\n');
    const itemChoice = Number(window.prompt(`Select inventory item by number:\n${itemOptions}`, '1'));
    if (!Number.isInteger(itemChoice) || itemChoice < 1 || itemChoice > inventory.length) { flash('Select a valid inventory item.'); return; }
    const item = inventory[itemChoice - 1];
    const supplierOptions = suppliers.map((supplier, index) => `${index + 1}. ${supplier.name}`).join('\n');
    const supplierChoice = Number(window.prompt(`Select supplier by number:\n${supplierOptions}`, String(Math.max(1, suppliers.findIndex(supplier => supplier.name === item.supplier) + 1))));
    if (!Number.isInteger(supplierChoice) || supplierChoice < 1 || supplierChoice > suppliers.length) { flash('Select a valid supplier.'); return; }
    const supplier = suppliers[supplierChoice - 1];
    const quantity = Number(window.prompt(`Quantity received (${item.unit})`, '1'));
    const unitCost = Number(window.prompt('Unit cost (SAR)', String(item.cost || 0)));
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost <= 0) { flash('Quantity and unit cost must be greater than zero.'); return; }
    const total = quantity * unitCost;
    const paid = Number(window.prompt(`Initial payment amount (SAR, 0–${total.toFixed(2)})`, total.toFixed(2)));
    if (!Number.isFinite(paid) || paid < 0 || paid > total) { flash('Initial payment must be between zero and the purchase total.'); return; }
    const paymentStatus: PurchaseRecord['paymentStatus'] = paid >= total ? 'Paid' : paid > 0 ? 'Part-paid' : 'Credit';
    let paymentMethod: PaymentMethod | undefined;
    if (paid > 0) {
      const method = (window.prompt('Payment method: Cash or Mada', 'Cash') || '').trim();
      if (!['Cash', 'Mada'].includes(method)) { flash('Payment method must be Cash or Mada.'); return; }
      paymentMethod = method as PaymentMethod;
    }
    const date = window.prompt('Purchase date (YYYY-MM-DD)', localDate()) || localDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00`).getTime()) || localDate(new Date(`${date}T00:00:00`)) !== date) { flash('Enter a valid purchase date.'); return; }
    const purchase: PurchaseRecord = { id: `purchase-${Date.now()}`, date, supplierId: supplier.id, supplierName: supplier.name, inventoryId: item.id, itemName: item.name, quantity, unit: item.unit, unitCost, total, paid, paymentStatus, paymentMethod, createdAt: new Date().toISOString() };
    if (apiConnected && apiToken) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/purchases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
          body: JSON.stringify({
            supplierId: supplier.id,
            invoiceNumber: `POS-${Date.now()}`,
            paid: purchase.paid,
            paymentMethod: paymentMethod || 'Cash',
            items: [{ ingredientId: item.id, quantity, unitCost }]
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Purchase could not be saved to the database.');
        purchase.id = result.purchase.id;
      } catch (error) {
        flash(error instanceof Error ? error.message : 'Purchase was not saved to the server.');
        return;
      }
    }
    setInventory(current => current.map(entry => entry.id === item.id ? { ...entry, stock: entry.stock + quantity, trackStock: true, cost: unitCost, supplier: supplier.name } : entry));
    if (purchase.total > purchase.paid) setSuppliers(current => current.map(entry => entry.id === supplier.id ? { ...entry, due: entry.due + purchase.total - purchase.paid } : entry));
    setPurchases(current => [purchase, ...current]);
    setLogs(current => [{ id: `purchase-log-${Date.now()}`, title: 'Stock purchase received', detail: `${item.name} · +${quantity} ${item.unit} · ${currency(purchase.total)} · ${supplier.name} · ${paymentStatus}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
    flash(apiConnected ? `Purchase saved to database. ${quantity} ${item.unit} added to inventory.` : `Purchase saved locally. ${quantity} ${item.unit} added to inventory.`);
  };
  const deletePurchase = async (purchase: PurchaseRecord) => {
    if (!window.confirm(`Reverse purchase of ${purchase.quantity} ${purchase.unit} ${purchase.itemName}? Any amount already paid will be recorded as a supplier refund.`)) return;
    if (apiConnected && apiToken) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/purchases/${encodeURIComponent(purchase.id)}/reverse`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiToken}` }
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Purchase could not be reversed.');
        if (Array.isArray(result.inventory)) setInventory(current => current.map(entry => {
          const saved = result.inventory.find((item: { id: string }) => item.id === entry.id);
          return saved ? { ...entry, stock: Number(saved.stock), trackStock: Boolean(saved.trackStock), cost: Number(saved.unitCost), supplier: saved.supplier || '—' } : entry;
        }));
        if (result.supplier) setSuppliers(current => current.map(entry => entry.id === result.supplier.id ? { ...entry, due: Number(result.supplier.payable) } : entry));
      } catch (error) {
        flash(error instanceof Error ? error.message : 'Purchase reversal failed. No local changes were made.');
        return;
      }
    } else {
      const item = inventory.find(entry => entry.id === purchase.inventoryId);
      if (!item || item.stock < purchase.quantity) { flash('Cannot reverse this purchase: current stock is lower than the received quantity.'); return; }
      setInventory(current => current.map(entry => entry.id === purchase.inventoryId ? { ...entry, stock: Math.max(0, entry.stock - purchase.quantity) } : entry));
      if (purchase.total > purchase.paid) setSuppliers(current => current.map(entry => entry.id === purchase.supplierId ? { ...entry, due: Math.max(0, entry.due - (purchase.total - purchase.paid)) } : entry));
    }
    setPurchases(current => current.filter(entry => entry.id !== purchase.id));
    setLogs(current => [{ id: `purchase-delete-${Date.now()}`, title: 'Stock purchase reversed', detail: `${purchase.itemName} · -${purchase.quantity} ${purchase.unit} · ${currency(purchase.total)}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
    flash(apiConnected ? 'Purchase reversed in the database; stock and supplier balances updated.' : 'Local purchase reversed and stock adjusted.');
  };
  const purchasesView = (): ReactNode => {
    const today = localDate();
    const month = today.slice(0, 7);
    const todayTotal = purchases.filter(item => item.date === today).reduce((sum, item) => sum + item.total, 0);
    const monthTotal = purchases.filter(item => item.date.startsWith(month)).reduce((sum, item) => sum + item.total, 0);
    const creditTotal = purchases.reduce((sum, item) => sum + Math.max(0, item.total - item.paid), 0);
    return <section className={`${panel} p-5`}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">{heading('Stock procurement','Purchase management','Record received goods, update inventory and track supplier credit. Connected records sync with the branch database.')}<button onClick={addPurchase} className="inline-flex items-center gap-2 rounded-xl bg-[#e7b943] px-3 py-2 text-xs font-semibold text-[#17130b]"><Plus size={15}/> Record purchase</button></div>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">{[{label:'Today',value:todayTotal},{label:'This month',value:monthTotal},{label:'Supplier balance due',value:creditTotal}].map(card=><div key={card.label} className="rounded-xl border border-white/[.06] bg-white/[.025] p-4"><div className="text-xs text-slate-400">{card.label}</div><div className="mt-2 text-xl font-semibold text-white">{currency(card.value)}</div></div>)}</div>
      <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-sm"><thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="pb-3">Date</th><th className="pb-3">Item</th><th className="pb-3">Supplier</th><th className="pb-3">Quantity</th><th className="pb-3">Unit cost</th><th className="pb-3">Total</th><th className="pb-3">Payment</th><th className="pb-3"/></tr></thead><tbody>{purchases.slice().sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt)).map(item=><tr key={item.id} className="border-t border-white/[.06]"><td className="py-3 text-slate-400">{item.date}</td><td className="py-3 font-medium text-white">{item.itemName}</td><td className="py-3 text-slate-400">{item.supplierName}</td><td className="py-3 text-slate-300">{item.quantity} {item.unit}</td><td className="py-3 text-slate-400">{currency(item.unitCost)}</td><td className="py-3 font-semibold text-white">{currency(item.total)}</td><td className="py-3 text-slate-400">{item.paymentStatus}{item.paymentMethod ? ` · ${item.paymentMethod}` : ''} · Due ${currency(Math.max(0,item.total-item.paid))}</td><td className="py-3 text-right"><button onClick={()=>deletePurchase(item)} className="rounded-lg border border-rose-400/15 px-2.5 py-1.5 text-xs text-rose-300">Reverse</button></td></tr>)}</tbody></table>{!purchases.length&&<p className="py-10 text-center text-sm text-slate-500">No purchases recorded yet. Record a purchase to receive stock.</p>}</div>
    </section>;
  };
  const addEmployee = async () => {
    const name = window.prompt('Employee name');
    if (!name?.trim()) return;
    const role = window.prompt('Job role', 'Staff') || 'Staff';
    const shift = window.prompt('Shift', 'Morning') || 'Morning';
    const salary = Number(window.prompt('Monthly salary (SAR)', '2500'));
    if (!Number.isFinite(salary) || salary < 0) { flash('Enter a valid salary amount.'); return; }
    let employee: Employee = { id: `emp-${Date.now()}`, name: name.trim(), role: role.trim(), shift: shift.trim(), status: 'Present', salary, advance: 0 };
    if (apiConnected && apiToken) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/employees`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiToken}`}, body:JSON.stringify({name:employee.name,role:employee.role,shift:employee.shift,salary:employee.salary}) });
        const result = await response.json();
        if (!response.ok || !result.employee) throw new Error(result.error || 'Employee could not be saved.');
        employee = {...employee,...result.employee,salary:Number(result.employee.salary),advance:Number(result.employee.advance||0)};
      } catch(error) { flash(error instanceof Error ? error.message : 'Employee was not saved.'); return; }
    }
    setEmployees(current => [employee, ...current]);
    setLogs(current => [{ id: `employee-${Date.now()}`, title: 'Employee added', detail: `${employee.name} · ${employee.role}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
    flash(apiConnected ? 'Employee saved to PostgreSQL.' : 'Employee added.');
  };
  const editEmployee = async (employee: Employee) => {
    const name = window.prompt('Employee name', employee.name);
    if (!name?.trim()) return;
    const role = window.prompt('Job role', employee.role);
    const shift = window.prompt('Shift', employee.shift);
    const salary = Number(window.prompt('Monthly salary (SAR)', String(employee.salary)));
    if (!Number.isFinite(salary) || salary < 0) { flash('Enter a valid salary amount.'); return; }
    const updated = { ...employee, name:name.trim(), role:role?.trim() || employee.role, shift:shift?.trim() || employee.shift, salary };
    if (apiConnected && apiToken) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/employees/${encodeURIComponent(employee.id)}`, { method:'PATCH', headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiToken}`}, body:JSON.stringify({name:updated.name,role:updated.role,shift:updated.shift,salary:updated.salary}) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Employee could not be updated.');
      } catch(error) { flash(error instanceof Error ? error.message : 'Employee was not updated.'); return; }
    }
    setEmployees(current => current.map(item => item.id === employee.id ? updated : item));
    setLogs(current => [{ id: `employee-edit-${Date.now()}`, title: 'Employee details updated', detail: name.trim(), time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
    flash(apiConnected ? 'Employee updated in PostgreSQL.' : 'Employee details updated.');
  };
  const updateAttendance = async (employee: Employee) => {
    const statuses: Employee['status'][] = ['Present', 'Absent', 'On Leave'];
    const next = statuses[(statuses.indexOf(employee.status) + 1) % statuses.length];
    if (apiConnected && apiToken) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/attendance`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiToken}`}, body:JSON.stringify({employeeId:employee.id,date:localDate(),status:next}) });
        const result = await response.json();
        if (!response.ok || !result.attendance) throw new Error(result.error || 'Attendance was not saved.');
      } catch(error) { flash(error instanceof Error ? error.message : 'Attendance was not saved.'); return; }
    }
    setEmployees(current => current.map(item => item.id === employee.id ? { ...item, status: next } : item));
    setLogs(current => [{ id: `attendance-${Date.now()}`, title: 'Attendance updated', detail: `${employee.name} · ${next}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
  };
  const deactivateEmployee = async (employee: Employee) => {
    if (!window.confirm(`Deactivate ${employee.name}? Past attendance and payroll history are kept.`)) return;
    if (apiConnected && apiToken) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/employees/${encodeURIComponent(employee.id)}/deactivate`, { method:'POST', headers:{Authorization:`Bearer ${apiToken}`} });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Employee could not be deactivated.');
      } catch(error) { flash(error instanceof Error ? error.message : 'Employee was not deactivated.'); return; }
    }
    setEmployees(current => current.filter(item => item.id !== employee.id));
    setAttendanceRows(current => current.filter(item => item.employeeId !== employee.id));
    setLogs(current => [{ id: `employee-off-${Date.now()}`, title: 'Employee deactivated', detail: employee.name, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
    flash(apiConnected ? `${employee.name} deactivated.` : `${employee.name} removed from the active team.`);
  };
  const changeAttendance = async (row: { employeeId: string; name: string; status: Employee['status'] }) => {
    if (!apiConnected || !apiToken) { const employee = employees.find(item => item.id === row.employeeId); if (employee) await updateAttendance(employee); return; }
    const statuses: Employee['status'][] = ['Present', 'Absent', 'On Leave'];
    const next = statuses[(statuses.indexOf(row.status) + 1) % statuses.length];
    try {
      const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/attendance`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiToken}`}, body:JSON.stringify({employeeId:row.employeeId,date:attendanceDate,status:next}) });
      const result = await response.json();
      if (!response.ok || !result.attendance) throw new Error(result.error || 'Attendance was not saved.');
    } catch(error) { flash(error instanceof Error ? error.message : 'Attendance was not saved.'); return; }
    setAttendanceRows(current => current.map(item => item.employeeId === row.employeeId ? { ...item, status: next } : item));
    if (attendanceDate === localDate()) setEmployees(current => current.map(item => item.id === row.employeeId ? { ...item, status: next } : item));
    setLogs(current => [{ id: `attendance-${Date.now()}`, title: 'Attendance updated', detail: `${row.name} · ${attendanceDate} · ${next}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
  };
  const employeesView = (): ReactNode => <section className={`${panel} p-5`}>
    <div className="mb-5 flex items-end justify-between gap-3">{heading('Team operations','Employee management','Maintain staff profiles, shifts and attendance status.') }{canManageHr&&<button onClick={addEmployee} className="rounded-xl bg-[#e7b943] px-3 py-2 text-xs font-semibold text-[#17130b]">Add employee</button>}</div>
    <div className="mb-4 grid grid-cols-3 gap-2">{[{label:'Present',count:employees.filter(item=>item.status==='Present').length},{label:'Absent',count:employees.filter(item=>item.status==='Absent').length},{label:'On leave',count:employees.filter(item=>item.status==='On Leave').length}].map(item=><div key={item.label} className="rounded-xl bg-white/[.035] p-3"><div className="text-xs text-slate-400">{item.label}</div><div className="mt-1 text-xl font-semibold text-white">{item.count}</div></div>)}</div>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{employees.map(employee=><article key={employee.id} className="rounded-2xl border border-white/[.07] bg-[#191e24] p-4"><div className="flex items-start justify-between gap-2"><div><h3 className="font-semibold text-white">{employee.name}</h3><p className="mt-1 text-xs text-slate-400">{employee.role} · {employee.shift}</p></div><span className={`rounded-full px-2 py-1 text-[10px] ${employee.status==='Present'?'bg-emerald-400/10 text-emerald-300':employee.status==='Absent'?'bg-rose-400/10 text-rose-300':'bg-amber-400/10 text-amber-200'}`}>{employee.status}</span></div><div className="mt-4 border-t border-white/[.06] pt-3 text-sm"><div className="flex justify-between text-slate-400"><span>Monthly salary</span><strong className="text-white">{currency(employee.salary)}</strong></div><div className="mt-2 flex justify-between text-slate-400"><span>Advance recorded</span><strong className="text-white">{currency(employee.advance)}</strong></div></div>{canManageHr&&<div className="mt-4 flex gap-2"><button onClick={()=>editEmployee(employee)} className="flex-1 rounded-lg border border-white/10 px-2 py-2 text-xs text-slate-300">Edit profile</button><button onClick={()=>updateAttendance(employee)} className="flex-1 rounded-lg border border-[#e7b943]/30 px-2 py-2 text-xs text-[#e7b943]">Update attendance</button><button onClick={()=>deactivateEmployee(employee)} className="flex-1 rounded-lg border border-rose-400/30 px-2 py-2 text-xs text-rose-300">Deactivate</button></div>}</article>)}</div>
  </section>;
  const attendanceView = (): ReactNode => {
    const rows = apiConnected ? attendanceRows : employees.map(employee => ({ employeeId: employee.id, name: employee.name, role: employee.role, shift: employee.shift, status: employee.status }));
    return <section className={`${panel} p-5`}>
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">{heading('Daily operations','Staff attendance',apiConnected?'Pick a date and cycle each employee through Present, Absent and On Leave. One record is kept per employee per day.':'Cycle each employee through Present, Absent and On Leave. Changes are saved locally.')}{apiConnected&&<input type="date" value={attendanceDate} max={localDate()} onChange={event=>{ if (event.target.value) setAttendanceDate(event.target.value); }} className="rounded-lg border border-white/10 bg-transparent px-3 py-2 text-xs text-slate-200"/>}</div>
    <div className="space-y-2">{rows.map(row=><div key={row.employeeId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/[.035] p-3"><div><div className="text-sm font-medium text-white">{row.name}</div><div className="mt-1 text-xs text-slate-500">{row.role} · {row.shift}</div></div><div className="flex items-center gap-2"><span className="text-xs text-slate-400">{row.status}</span><button onClick={()=>changeAttendance(row)} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-200">Change status</button></div></div>)}</div>
  </section>;
  };
  const recordSalaryAdvance = async (employee: Employee) => {
    const amount = Number(window.prompt(`Advance amount for ${employee.name} (SAR)`, '0'));
    if (!Number.isFinite(amount) || amount <= 0) { flash('Enter an advance greater than zero.'); return; }
    const note = window.prompt('Advance note (optional)', 'Salary advance') || 'Salary advance';
    if (apiConnected && apiToken) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/employees/${encodeURIComponent(employee.id)}/advances`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiToken}`}, body:JSON.stringify({amount,note}) });
        const result = await response.json();
        if (!response.ok || !result.advance) throw new Error(result.error || 'Advance was not saved.');
      } catch(error) { flash(error instanceof Error ? error.message : 'Advance was not saved.'); return; }
    }
    setEmployees(current => current.map(item => item.id === employee.id ? { ...item, advance: item.advance + amount } : item));
    setLogs(current => [{ id: `advance-${Date.now()}`, title: 'Salary advance recorded', detail: `${employee.name} · ${currency(amount)} · ${note}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
    flash(apiConnected ? `Advance saved to PostgreSQL for ${employee.name}.` : `Advance recorded for ${employee.name}.`);
  };
  const createPayroll = async () => {
    if (!employees.length) { flash('Add an employee before creating payroll.'); return; }
    const period = window.prompt('Payroll month (YYYY-MM)', localDate().slice(0, 7)) || '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) { flash('Enter a valid payroll month in YYYY-MM format.'); return; }
    const employeeOptions = employees.map((employee, index) => `${index + 1}. ${employee.name} · ${currency(employee.salary)}`).join('\n');
    const choice = Number(window.prompt(`Select employee:\n${employeeOptions}`, '1'));
    if (!Number.isInteger(choice) || choice < 1 || choice > employees.length) { flash('Select a valid employee.'); return; }
    const employee = employees[choice - 1];
    if (payroll.some(item => item.employeeId === employee.id && item.period === period)) { flash('Payroll already exists for this employee and month.'); return; }
    const bonus = Number(window.prompt('Bonus (SAR)', '0'));
    if (!Number.isFinite(bonus) || bonus < 0) { flash('Enter a valid bonus amount.'); return; }
    const advanceDeduction = Number(window.prompt(`Outstanding advance: ${currency(employee.advance)}. Deduct how much?`, String(Math.min(employee.advance, employee.salary + bonus))));
    if (!Number.isFinite(advanceDeduction) || advanceDeduction < 0 || advanceDeduction > employee.advance || advanceDeduction > employee.salary + bonus) { flash('Advance deduction is outside the allowed amount.'); return; }
    const otherDeduction = Number(window.prompt('Other deduction, for example a penalty (SAR)', '0'));
    if (!Number.isFinite(otherDeduction) || otherDeduction < 0) { flash('Enter a valid deduction amount.'); return; }
    const deductionNote = otherDeduction > 0 ? (window.prompt('Deduction reason (optional)', '') || '').trim() : '';
    const netSalary = round2(employee.salary + bonus - advanceDeduction - otherDeduction);
    if (netSalary < 0) { flash('Deductions cannot be more than salary plus bonus.'); return; }
    const record: PayrollRecord = { id: `payroll-${employee.id}-${period}`, employeeId: employee.id, employeeName: employee.name, period, baseSalary: employee.salary, bonus, advanceDeduction, otherDeduction, deductionNote, netSalary, payments: [], createdAt: new Date().toISOString() };
    if (apiConnected && apiToken) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/payroll`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiToken}`}, body:JSON.stringify({employeeId:employee.id,period,bonus,advanceDeduction,otherDeduction,deductionNote}) });
        const result = await response.json();
        if (!response.ok || !result.payroll) throw new Error(result.error || 'Payroll could not be created.');
        record.id = result.payroll.id; record.createdAt = result.payroll.createdAt; record.netSalary = Number(result.payroll.netSalary);
      } catch(error) { flash(error instanceof Error ? error.message : 'Payroll was not saved.'); return; }
    }
    setPayroll(current => [record, ...current]);
    if (advanceDeduction > 0) setEmployees(current => current.map(item => item.id === employee.id ? { ...item, advance: item.advance - advanceDeduction } : item));
    setLogs(current => [{ id: `payroll-create-${Date.now()}`, title: 'Payroll created', detail: `${employee.name} · ${period} · Net ${currency(netSalary)} · Advance deduction ${currency(advanceDeduction)}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
    flash(`Payroll created for ${employee.name}.`);
  };
  const recordPayrollPayment = async (record: PayrollRecord) => {
    const paidSoFar = record.payments.reduce((sum, payment) => sum + payment.amount, 0);
    const remaining = Math.max(0, round2(record.netSalary - paidSoFar));
    if (remaining <= 0) { flash('This payroll is already fully paid.'); return; }
    const amount = Number(window.prompt(`Remaining salary: ${currency(remaining)}. Payment amount (SAR)`, String(remaining)));
    if (!Number.isFinite(amount) || amount <= 0 || amount > remaining || round2(amount) !== amount) { flash('Enter a payment amount within the remaining balance.'); return; }
    const method = (window.prompt('Payment method: Cash or Mada', 'Cash') || 'Cash').trim();
    if (!['Cash', 'Mada'].includes(method)) { flash('Payment method must be Cash or Mada.'); return; }
    let payment: PayrollPayment = { id: `salary-payment-${Date.now()}`, amount, paymentMethod: method as PaymentMethod, date: localDate(), createdAt: new Date().toISOString() };
    if (apiConnected && apiToken) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/payroll/${encodeURIComponent(record.id)}/payments`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiToken}`}, body:JSON.stringify({amount,method,date:localDate()}) });
        const result = await response.json();
        if (!response.ok || !result.payment) throw new Error(result.error || 'Salary payment was not saved.');
        payment = {id:result.payment.id,amount:Number(result.payment.amount),paymentMethod:result.payment.paymentMethod,date:result.payment.date,createdAt:result.payment.createdAt};
      } catch(error) { flash(error instanceof Error ? error.message : 'Salary payment was not saved.'); return; }
    }
    setPayroll(current => current.map(item => item.id === record.id ? { ...item, payments: [...item.payments, payment] } : item));
    setLogs(current => [{ id: `salary-payment-log-${Date.now()}`, title: 'Salary payment recorded', detail: `${record.employeeName} · ${record.period} · ${currency(amount)} · ${method}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
    flash(apiConnected ? 'Salary payment saved to PostgreSQL.' : 'Salary payment saved.');
  };
  const payrollView = (): ReactNode => {
    const totalDue = payroll.reduce((sum, item) => sum + Math.max(0, round2(item.netSalary - item.payments.reduce((paid, payment) => paid + payment.amount, 0))), 0);
    const totalPaid = payroll.reduce((sum, item) => sum + item.payments.reduce((paid, payment) => paid + payment.amount, 0), 0);
    const month = localDate().slice(0, 7);
    const monthRecords = payroll.filter(item => item.period === month);
    return <div className="space-y-4">
      <section className={`${panel} p-5`}>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">{heading('Finance & team','Salary & payroll','Create monthly salary records, track advances and record Cash or Mada payments. Connected mode stores team and payroll records in PostgreSQL.')}{canManageHr&&<button onClick={createPayroll} className="rounded-xl bg-[#e7b943] px-3 py-2 text-xs font-semibold text-[#17130b]">Create payroll</button>}</div>
        <div className="mb-5 grid gap-3 sm:grid-cols-3">{[{label:'This month payroll',value:monthRecords.reduce((sum,item)=>sum+item.netSalary,0)},{label:'Salary paid',value:totalPaid},{label:'Salary outstanding',value:totalDue}].map(card=><div key={card.label} className="rounded-xl border border-white/[.06] bg-white/[.025] p-4"><div className="text-xs text-slate-400">{card.label}</div><div className="mt-2 text-xl font-semibold text-white">{currency(card.value)}</div></div>)}</div>
        <div className="mb-5 space-y-2">{employees.map(employee=><div key={employee.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/[.035] p-3"><div><div className="text-sm font-medium text-white">{employee.name}</div><div className="mt-1 text-xs text-slate-500">Monthly salary {currency(employee.salary)} · Advance outstanding {currency(employee.advance)}</div></div>{canManageHr&&<button onClick={()=>recordSalaryAdvance(employee)} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300">Record advance</button>}</div>)}</div>
        <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm"><thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="pb-3">Month</th><th className="pb-3">Employee</th><th className="pb-3 text-right">Net salary</th><th className="pb-3 text-right">Paid</th><th className="pb-3 text-right">Remaining</th><th className="pb-3">Status</th><th className="pb-3"/></tr></thead><tbody>{payroll.slice().sort((a,b)=>b.period.localeCompare(a.period)||a.employeeName.localeCompare(b.employeeName)).map(record=>{const paidAmount=record.payments.reduce((sum,payment)=>sum+payment.amount,0);const remaining=Math.max(0,round2(record.netSalary-paidAmount));return <tr key={record.id} className="border-t border-white/[.06]"><td className="py-3 text-slate-400">{record.period}</td><td className="py-3 font-medium text-white">{record.employeeName}<div className="mt-1 text-[10px] text-slate-500">Base {currency(record.baseSalary)} · Bonus {currency(record.bonus)} · Advance deduction {currency(record.advanceDeduction)}{record.otherDeduction ? ` · Deduction ${currency(record.otherDeduction)}${record.deductionNote ? ` (${record.deductionNote})` : ''}` : ''}</div></td><td className="py-3 text-right text-white">{currency(record.netSalary)}</td><td className="py-3 text-right text-emerald-300">{currency(paidAmount)}</td><td className="py-3 text-right text-amber-200">{currency(remaining)}</td><td className="py-3"><span className={`rounded-full px-2 py-1 text-[10px] ${remaining===0?'bg-emerald-400/10 text-emerald-300':paidAmount>0?'bg-amber-400/10 text-amber-200':'bg-white/[.06] text-slate-400'}`}>{remaining===0?'Paid':paidAmount>0?'Part-paid':'Unpaid'}</span></td><td className="py-3 text-right">{remaining>0&&<button onClick={()=>recordPayrollPayment(record)} className="rounded-lg border border-[#e7b943]/30 px-2.5 py-1.5 text-xs text-[#e7b943]">Pay salary</button>}</td></tr>})}</tbody></table>{!payroll.length&&<p className="py-10 text-center text-sm text-slate-500">No payroll records. Create a monthly payroll to begin.</p>}</div>
        {payroll.some(item=>item.payments.length>0)&&<div className="mt-5 border-t border-white/[.06] pt-4"><h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Payment history</h3><div className="space-y-2">{payroll.flatMap(record=>record.payments.map(payment=>({record,payment}))).sort((a,b)=>b.payment.createdAt.localeCompare(a.payment.createdAt)).map(({record,payment})=><div key={payment.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-white/[.03] px-3 py-2 text-xs"><span className="text-slate-300">{record.employeeName} · {record.period} · {payment.paymentMethod}</span><span className="text-white">{payment.date} · {currency(payment.amount)}</span></div>)}</div></div>}
      </section>
    </div>;
  };
  const addExpense = async () => {
    const categories = ['Rent', 'Utilities', 'Staff welfare', 'Transport', 'Maintenance', 'Packaging', 'Cleaning', 'Marketing', 'Other'];
    const category = window.prompt(`Expense category (\n${categories.join(', ')}\n)`, 'Other');
    if (!category?.trim()) return;
    const description = window.prompt('Expense description');
    if (!description?.trim()) return;
    const amount = Number(window.prompt('Amount (SAR)', '0'));
    if (!Number.isFinite(amount) || amount <= 0) { flash('Enter an expense amount greater than zero.'); return; }
    const paymentMethod = (window.prompt('Payment method: Cash or Mada', 'Cash') || 'Cash').trim();
    if (!['Cash', 'Mada'].includes(paymentMethod)) { flash('Payment method must be Cash or Mada.'); return; }
    const date = window.prompt('Expense date (YYYY-MM-DD)', localDate()) || localDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00`).getTime()) || localDate(new Date(`${date}T00:00:00`)) !== date) { flash('Enter a valid date in YYYY-MM-DD format.'); return; }
    const expense: ExpenseRecord = { id: `expense-${Date.now()}`, date, category: category.trim(), description: description.trim(), amount, paymentMethod: paymentMethod as PaymentMethod, createdAt: new Date().toISOString() };
    if (apiConnected && apiToken) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/expenses`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiToken}`}, body:JSON.stringify({category:expense.category,description:expense.description,amount:expense.amount,paymentMethod:expense.paymentMethod,date:expense.date}) });
        const result = await response.json();
        if (!response.ok || !result.expense) throw new Error(result.error || 'Expense could not be saved to the server.');
        expense.id = result.expense.id; expense.createdAt = result.expense.createdAt;
      } catch (error) { flash(error instanceof Error ? error.message : 'Expense was not saved.'); return; }
    }
    setExpenses(current => [expense, ...current]);
    setLogs(current => [{ id: `expense-log-${Date.now()}`, title: 'Expense recorded', detail: `${expense.category} · ${expense.description} · ${currency(amount)} · ${paymentMethod}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
    flash(apiConnected ? 'Expense saved to PostgreSQL.' : 'Expense saved on this device.');
  };
  const deleteExpense = async (expense: ExpenseRecord) => {
    if (!window.confirm(`Delete expense “${expense.description}” for ${currency(expense.amount)}?`)) return;
    if (apiConnected && apiToken) {
      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/expenses/${encodeURIComponent(expense.id)}`, { method:'DELETE', headers:{Authorization:`Bearer ${apiToken}`} });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Expense could not be deleted from the server.');
      } catch (error) { flash(error instanceof Error ? error.message : 'Expense could not be deleted.'); return; }
    }
    setExpenses(current => current.filter(item => item.id !== expense.id));
    setLogs(current => [{ id: `expense-delete-${Date.now()}`, title: 'Expense deleted', detail: `${expense.description} · ${currency(expense.amount)}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current]);
    flash('Expense deleted.');
  };
  const expensesView = (): ReactNode => {
    const today = localDate();
    const month = today.slice(0, 7);
    const todayTotal = expenses.filter(item => item.date === today).reduce((sum, item) => sum + item.amount, 0);
    const monthTotal = expenses.filter(item => item.date.startsWith(month)).reduce((sum, item) => sum + item.amount, 0);
    const categoryTotals = expenses.reduce<Record<string, number>>((totals, item) => { totals[item.category] = (totals[item.category] || 0) + item.amount; return totals; }, {});
    return <div className="space-y-4">
      <section className={`${panel} p-5`}>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">{heading('Finance control','Operating expenses','Record and review shop expenses in SAR. Connected records are shared through PostgreSQL.')}<button onClick={addExpense} className="inline-flex items-center gap-2 rounded-xl bg-[#e7b943] px-3 py-2 text-xs font-semibold text-[#17130b]"><Plus size={15}/> Add expense</button></div>
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          {[{label:'Today',value:todayTotal},{label:'This month',value:monthTotal},{label:'All recorded',value:expenses.reduce((sum,item)=>sum+item.amount,0)}].map(card=><div key={card.label} className="rounded-xl border border-white/[.06] bg-white/[.025] p-4"><div className="text-xs text-slate-400">{card.label}</div><div className="mt-2 text-xl font-semibold text-white">{currency(card.value)}</div></div>)}
        </div>
        {Object.keys(categoryTotals).length>0&&<div className="mb-5 flex flex-wrap gap-2">{Object.entries(categoryTotals).sort((a,b)=>b[1]-a[1]).map(([name,amount])=><span key={name} className="rounded-lg border border-white/[.07] bg-white/[.025] px-3 py-2 text-xs text-slate-300">{name} <strong className="ml-1 text-[#e7b943]">{currency(amount)}</strong></span>)}</div>}
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="pb-3">Date</th><th className="pb-3">Category</th><th className="pb-3">Description</th><th className="pb-3">Payment</th><th className="pb-3 text-right">Amount</th><th className="pb-3"/></tr></thead><tbody>{expenses.slice().sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt)).map(item=><tr key={item.id} className="border-t border-white/[.06]"><td className="py-3 text-slate-400">{item.date}</td><td className="py-3 text-slate-300">{item.category}</td><td className="py-3 font-medium text-white">{item.description}</td><td className="py-3 text-slate-400">{item.paymentMethod}</td><td className="py-3 text-right font-semibold text-white">{currency(item.amount)}</td><td className="py-3 text-right"><button onClick={()=>deleteExpense(item)} className="rounded-lg border border-rose-400/15 px-2.5 py-1.5 text-xs text-rose-300">Delete</button></td></tr>)}</tbody></table>{!expenses.length&&<p className="py-10 text-center text-sm text-slate-500">No expenses recorded. Add the first shop expense to start tracking.</p>}</div>
      </section>
    </div>;
  };
  const customersView = (): ReactNode => <section className={`${panel} p-5`}><div className="mb-5 flex items-end justify-between gap-3">{heading('Guest relationships','Customers','Customer contact details and loyalty points.')}<button onClick={addCustomer} className="inline-flex items-center gap-2 rounded-xl bg-[#e7b943] px-3 py-2 text-xs font-semibold text-[#17130b]"><Plus size={15}/> Add customer</button></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{customers.map(customer=><article key={customer.id} className="rounded-2xl border border-white/[.07] bg-[#191e24] p-4"><div className="flex items-center justify-between"><h3 className="font-semibold text-white">{customer.name}</h3><span className="rounded-full bg-[#e7b943]/10 px-2 py-1 text-xs text-[#e7b943]">{customer.loyaltyPoints} pts</span></div><p className="mt-3 text-sm text-slate-400">{customer.phone || 'No phone saved'}</p><p className="mt-1 text-xs text-slate-500">{customer.address || 'No address saved'}</p><div className="mt-4 border-t border-white/[.06] pt-3 text-xs text-slate-400">Loyalty account <strong className="float-right text-white">Active</strong></div></article>)}</div></section>;
  const accounting = (): ReactNode => <div className="grid gap-4 xl:grid-cols-2"><section className={`${panel} p-5`}>{heading('Finance','Recorded sales','Figures below are derived from saved order records.') }<div className="mt-5 space-y-4 text-sm"><div className="flex justify-between border-b border-white/[.06] pb-3 text-slate-400"><span>Sales today</span><strong className="text-white">{currency(salesToday)}</strong></div><div className="flex justify-between border-b border-white/[.06] pb-3 text-slate-400"><span>Recorded order count</span><strong className="text-white">{orders.filter(order=>order.number!=='HOLD').length}</strong></div><div className="flex justify-between border-b border-white/[.06] pb-3 text-slate-400"><span>Payments received</span><strong className="text-white">{currency(orders.filter(order=>order.number!=='HOLD').reduce((n,order)=>n+order.paid,0))}</strong></div><div className="flex justify-between border-b border-white/[.06] pb-3 text-slate-400"></div><p className="text-xs leading-5 text-amber-200/70">Profit & loss needs recorded purchases and operating expenses; estimates are intentionally not shown as actuals.</p></div></section><section className={`${panel} p-5`}>{<div className="flex items-start justify-between gap-3">{heading('Payables','Supplier balances',apiConnected?'Live supplier balances from the POS database.':'Local supplier records; connect the API for shared balances.') }<button onClick={addSupplier} className="shrink-0 rounded-lg border border-[#e7b943]/40 px-3 py-2 text-xs font-semibold text-[#e7b943]">Add supplier</button></div>}<div className="mt-4 space-y-2">{suppliers.map(supplier=><div key={supplier.id} className="flex items-center justify-between gap-3 rounded-xl bg-white/[.035] p-3"><div className="min-w-0"><div className="text-sm text-white">{supplier.name}</div><div className="mt-1 text-xs text-slate-500">{supplier.category} · {supplier.phone || 'No phone'}</div></div><div className="flex shrink-0 items-center gap-3"><strong className="text-sm text-[#e7b943]">{currency(supplier.due)}</strong><button onClick={()=>editSupplier(supplier)} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300">Edit</button><button onClick={()=>paySupplier(supplier)} disabled={!apiConnected||supplier.due<=0} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:border-[#e7b943]/40 disabled:cursor-not-allowed disabled:opacity-40">Pay</button></div></div>)}</div></section></div>;
  const reportStartDate = (range: string): string => {
    const now = new Date();
    if (range === 'Today') return localDate(now);
    if (range === 'Last 7 days') { now.setDate(now.getDate() - 6); return localDate(now); }
    if (range === 'This month') return localDate(new Date(now.getFullYear(), now.getMonth(), 1));
    return '0000-01-01';
  };
  const exportCsv = (filename: string, rows: Array<Array<string | number>>) => {
    const csv = rows.map(row => row.map(value => {
      const text = String(value ?? '');
      return '"' + text.replace(/"/g, '""') + '"';
    }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\\uFEFF', csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
  };
  const reportsView = (): ReactNode => {
    const start = reportStartDate(reportRange);
    const validOrders = orders.filter(order => order.number !== 'HOLD' && localDate(new Date(order.createdAt)) >= start);
    const validExpenses = expenses.filter(item => item.date >= start);
    const validPurchases = purchases.filter(item => item.date >= start);
    const sales = validOrders.reduce((sum, order) => sum + order.total, 0);
    const paid = validOrders.reduce((sum, order) => sum + order.paid, 0);
    const paymentTotals: Record<PaymentMethod, number> = { Cash: 0, Mada: 0 };
    validOrders.forEach(order => { paymentTotals[order.paymentMethod] += order.paid; });
    const productTotals = validOrders.flatMap(order => order.items).reduce<Array<{name:string;quantity:number;revenue:number}>>((list,item) => {
      const found = list.find(entry => entry.name === item.name);
      if (found) { found.quantity += item.qty; found.revenue += item.qty * item.unitPrice; }
      else list.push({ name: item.name, quantity: item.qty, revenue: item.qty * item.unitPrice });
      return list;
    }, []).sort((a,b) => b.quantity-a.quantity);
    const dailyTotals = validOrders.reduce<Record<string,number>>((map,order) => {
      const day = localDate(new Date(order.createdAt)); map[day] = (map[day] || 0) + order.total; return map;
    }, {});
    const dailyRows = Object.entries(dailyTotals).sort((a,b)=>b[0].localeCompare(a[0]));
    const expenseTotal = validExpenses.reduce((sum,item)=>sum+item.amount,0);
    const purchaseTotal = validPurchases.reduce((sum,item)=>sum+item.total,0);
    const salaryPaid = payroll.flatMap(record => record.payments).filter(payment => payment.date >= start).reduce((sum,payment)=>sum+payment.amount,0);
    const maxDaily = Math.max(1,...dailyRows.map(([,amount])=>amount));
    const reportRows = [
      ['Report range',reportRange],['Orders',validOrders.length],['Sales (SAR)',sales.toFixed(2)],['Payments received (SAR)',paid.toFixed(2)],
      ['Cash received (SAR)',paymentTotals.Cash.toFixed(2)],['Mada received (SAR)',paymentTotals.Mada.toFixed(2)],
      ['Expenses recorded (SAR)',expenseTotal.toFixed(2)],['Purchases recorded (SAR)',purchaseTotal.toFixed(2)],['Salary paid (SAR)',salaryPaid.toFixed(2)]
    ];
    return <div className="space-y-4">
      <section className={`${panel} p-5`}>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">{heading('Business intelligence','Sales reports','Review recorded sales, payment methods, popular items and operating outflows.')}<div className="flex flex-wrap gap-2"><select value={reportRange} onChange={event=>setReportRange(event.target.value)} className="rounded-xl border border-white/10 bg-[#171d22] px-3 py-2 text-xs text-slate-200"><option>Today</option><option>Last 7 days</option><option>This month</option><option>All time</option></select><button onClick={()=>exportCsv('musafir-sales-report.csv',reportRows)} className="rounded-xl border border-[#e7b943]/40 px-3 py-2 text-xs font-semibold text-[#e7b943]">Export summary CSV</button></div></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[{label:'Sales',value:currency(sales)},{label:'Orders',value:String(validOrders.length)},{label:'Payments received',value:currency(paid)},{label:'Average order value',value:currency(validOrders.length?sales/validOrders.length:0)}].map(card=><div key={card.label} className="rounded-xl border border-white/[.06] bg-white/[.025] p-4"><div className="text-xs text-slate-400">{card.label}</div><div className="mt-2 text-xl font-semibold text-white">{card.value}</div></div>)}</div>
      </section>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className={`${panel} p-5`}>{heading('Sales trend','Daily sales','Order totals grouped by the POS local date.')}<div className="mt-5 space-y-3">{dailyRows.slice(0,14).map(([day,amount])=><div key={day}><div className="mb-1 flex justify-between text-xs"><span className="text-slate-400">{day}</span><strong className="text-white">{currency(amount)}</strong></div><div className="h-2 overflow-hidden rounded-full bg-white/[.06]"><div className="h-full rounded-full bg-[#e7b943]" style={{width:`${amount/maxDaily*100}%`}}/></div></div>)}{!dailyRows.length&&<p className="py-8 text-center text-sm text-slate-500">No sales in this period.</p>}</div></section>
        <section className={`${panel} p-5`}>{heading('Tender mix','Cash and Mada','Based on recorded payments for the selected period.')}<div className="mt-5 space-y-4">{(['Cash','Mada'] as PaymentMethod[]).map(method=><div key={method} className="rounded-xl bg-white/[.035] p-4"><div className="flex justify-between text-sm"><span className="text-slate-300">{method}</span><strong className="text-white">{currency(paymentTotals[method])}</strong></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[.06]"><div className="h-full rounded-full bg-[#e7b943]" style={{width:`${paid?paymentTotals[method]/paid*100:0}%`}}/></div></div>)}</div></section>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className={`${panel} p-5`}>{heading('Menu performance','Top selling items','Sorted by units sold; item revenue excludes no recorded discounts allocation.')}<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[420px] text-left text-sm"><thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="pb-3">Item</th><th className="pb-3 text-right">Qty</th><th className="pb-3 text-right">Line value</th></tr></thead><tbody>{productTotals.slice(0,12).map(item=><tr key={item.name} className="border-t border-white/[.06]"><td className="py-3 font-medium text-white">{item.name}</td><td className="py-3 text-right text-slate-300">{item.quantity}</td><td className="py-3 text-right text-slate-300">{currency(item.revenue)}</td></tr>)}</tbody></table>{!productTotals.length&&<p className="py-8 text-center text-sm text-slate-500">No item sales in this period.</p>}</div></section>
        <section className={`${panel} p-5`}>{heading('Operating outflows','Recorded costs','Purchases are shown separately from expenses and are not treated as consumed cost of goods.')}<div className="mt-5 space-y-4 text-sm">{[{label:'Operating expenses',value:expenseTotal},{label:'Purchases received',value:purchaseTotal},{label:'Salary payments made',value:salaryPaid}].map(item=><div key={item.label} className="flex justify-between border-b border-white/[.06] pb-3 text-slate-400"><span>{item.label}</span><strong className="text-white">{currency(item.value)}</strong></div>)}</div></section>
      </div>
      <section className={`${panel} p-5`}>{heading('Daily ledger','Sales by date','Export contains the summary totals above.')}<div className="overflow-x-auto"><table className="w-full min-w-[420px] text-left text-sm"><thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="pb-3">Date</th><th className="pb-3 text-right">Orders</th><th className="pb-3 text-right">Sales</th></tr></thead><tbody>{dailyRows.map(([day,amount])=><tr key={day} className="border-t border-white/[.06]"><td className="py-3 text-slate-300">{day}</td><td className="py-3 text-right text-slate-300">{validOrders.filter(order=>localDate(new Date(order.createdAt))===day).length}</td><td className="py-3 text-right font-medium text-white">{currency(amount)}</td></tr>)}</tbody></table></div></section>
    </div>;
  };
  const profitView = (): ReactNode => {
    const start = reportStartDate(reportRange);
    const periodOrders = orders.filter(order=>order.number!=='HOLD' && localDate(new Date(order.createdAt))>=start);
    const periodExpenses = expenses.filter(item=>item.date>=start);
    const periodPurchases = purchases.filter(item=>item.date>=start);
    const periodPayroll = payroll.filter(record=>record.period>=start.slice(0,7));
    const grossSales = periodOrders.reduce((sum,order)=>sum+order.total,0);
    const recordedVat = periodOrders.reduce((sum,order)=>sum+order.tax,0);
    const salesBeforeVat = Math.max(0,grossSales-recordedVat);
    const expenseTotal = periodExpenses.reduce((sum,item)=>sum+item.amount,0);
    const salaryPaid = periodPayroll.flatMap(record=>record.payments).filter(payment=>payment.date>=start).reduce((sum,payment)=>sum+payment.amount,0);
    const salaryOutstanding = periodPayroll.reduce((sum,record)=>sum+Math.max(0,record.netSalary-record.payments.reduce((paid,payment)=>paid+payment.amount,0)),0);
    const purchaseTotal = periodPurchases.reduce((sum,item)=>sum+item.total,0);
    const purchasePaid = periodPurchases.reduce((sum,item)=>sum+item.paid,0);
    const operatingResult = salesBeforeVat-expenseTotal-salaryPaid;
    return <div className="space-y-4">
      <section className={`${panel} p-5`}><div className="mb-5 flex flex-wrap items-end justify-between gap-3">{heading('Financial overview','Profit & loss','A transparent operating view using recorded data only. Ingredient COGS is not calculated until recipe-cost reconciliation is complete.')}<select value={reportRange} onChange={event=>setReportRange(event.target.value)} className="rounded-xl border border-white/10 bg-[#171d22] px-3 py-2 text-xs text-slate-200"><option>Today</option><option>Last 7 days</option><option>This month</option><option>All time</option></select></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[{label:'Sales before recorded VAT',value:currency(salesBeforeVat)},{label:'Operating expenses',value:currency(expenseTotal)},{label:'Salary paid',value:currency(salaryPaid)},{label:'Operating result before COGS',value:currency(operatingResult)}].map(card=><div key={card.label} className="rounded-xl border border-white/[.06] bg-white/[.025] p-4"><div className="text-xs text-slate-400">{card.label}</div><div className="mt-2 text-xl font-semibold text-white">{card.value}</div></div>)}</div>
      </section>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className={`${panel} p-5`}>{heading('Income','Recorded sales bridge','Sales totals are taken from completed POS order records.')}<div className="mt-4 space-y-3 text-sm">{[{label:'Sales including VAT',value:grossSales},{label:'Less recorded VAT',value:-recordedVat},{label:'Sales before recorded VAT',value:salesBeforeVat},{label:'Less operating expenses',value:-expenseTotal},{label:'Less salary payments',value:-salaryPaid}].map(row=><div key={row.label} className="flex justify-between border-b border-white/[.06] pb-3 text-slate-400"><span>{row.label}</span><strong className={row.value<0?'text-rose-300':'text-white'}>{row.value<0?'−':''}{currency(Math.abs(row.value))}</strong></div>)}<div className="flex justify-between pt-1 text-sm"><strong className="text-slate-200">Operating result before COGS</strong><strong className="text-[#e7b943]">{currency(operatingResult)}</strong></div></div></section>
        <section className={`${panel} p-5`}>{heading('Liabilities & purchasing','Payroll and purchases','Purchases are cash/inventory acquisition records, not automatically expenses.')}<div className="mt-4 space-y-3 text-sm">{[{label:'Salary paid in period',value:salaryPaid},{label:'Salary outstanding on selected payrolls',value:salaryOutstanding},{label:'Purchase value',value:purchaseTotal},{label:'Initial purchase payments recorded',value:purchasePaid}].map(row=><div key={row.label} className="flex justify-between border-b border-white/[.06] pb-3 text-slate-400"><span>{row.label}</span><strong className="text-white">{currency(row.value)}</strong></div>)}</div></section>
      </div>
      <p className="rounded-xl border border-amber-300/15 bg-amber-300/[.04] p-4 text-xs leading-5 text-amber-100/70">This is not final net profit. Recipe-based ingredient cost of goods sold, stock consumption valuation, and tax adjustment for discounts are not yet reconciled. Purchases are reported separately to avoid counting inventory purchases as both an asset and an expense.</p>
    </div>;
  };
  const qr = (): ReactNode => <div className="grid gap-4 xl:grid-cols-[1fr_320px]"><section className={`${panel} p-5`}>{heading('Digital menu','Customer QR menu','Customer-facing menu preview using the current product list.') }<div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{products.slice(0,6).map(product=><article key={product.id} className="overflow-hidden rounded-xl border border-white/[.07] bg-[#191e24]"><img src={product.image} alt={product.name} className="h-28 w-full object-cover"/><div className="p-3"><div className="text-sm font-medium text-white">{product.name}</div><div className="mt-1 text-sm text-[#e7b943]">{currency(product.price)}</div></div></article>)}</div></section><section className={`${panel} p-5`}>{heading('Table ordering','QR preview','Live QR generation requires a public hosted menu URL.') }<div className="mt-5 grid aspect-square place-items-center rounded-2xl border border-dashed border-white/15 bg-white p-5 text-center text-sm text-slate-500"><div><Grid2X2 className="mx-auto mb-2 text-slate-700" size={58}/>QR placeholder<br/><span className="text-xs">Not scannable in demo mode</span></div></div></section></div>;
  const moduleMessages: Record<string,string> = { tables:'Table occupancy, seating and table transfer workflows are not implemented yet.', reservations:'Reservation scheduling and guest reminders are not implemented yet.', menu:'Menu editing and product creation are planned; current products are available in POS.', categories:'Category editing is not implemented yet; category filters are available in POS.', recipes:'Recipe editor and ingredient-to-stock mapping need completion.', purchases:'Record goods received, add quantities to inventory and track supplier credit locally.', delivery:'Dispatch assignment and courier tracking need completion.', expenses:'Record shop operating expenses, payment method and expense date; review daily and monthly totals.', employees:'Manage employee profiles, monthly salaries and shift details in local POS storage.', attendance:'Update daily employee attendance status in local POS storage.', payroll:'Create monthly payroll, track salary advances, and record full or partial Cash/Mada salary payments.', reports:'Dashboard includes actual order totals and item sales; date filtering/export reports need completion.', profit:'Reliable profit & loss requires recorded COGS, purchases, expenses and salaries; not yet implemented.',  discounts:'Coupon codes and discount authorization need completion.', roles:'Authentication and enforceable role permissions need a secure backend.', settings:'Restaurant and branch settings need completion.' };
  const selectedLabel = moduleGroups.flatMap(group=>group.items).find(item=>item.id===view)?.label || 'Dashboard';
  const placeholder = (): ReactNode => <section className={`${panel} p-6 md:p-8`}><div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#e7b943]/10 text-[#e7b943]"><Activity size={21}/></div><div className="mt-5">{heading('Module status',selectedLabel,'This module is listed for the complete product scope.')}</div><p className="mt-4 max-w-2xl text-sm leading-6 text-slate-400">{moduleMessages[view] || 'This module is planned but is not part of the current working demo.'}</p><div className="mt-6 rounded-xl border border-amber-300/15 bg-amber-300/[.04] p-4 text-xs leading-5 text-amber-100/70">This screen is intentionally marked as incomplete—no demo action or placeholder value is presented as a completed workflow.</div><button onClick={()=>setView('dashboard')} className="mt-5 rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 hover:border-white/20">Back to dashboard</button></section>;
  const restrictedView = (): ReactNode => <section className={`${panel} p-6`}>{heading('Access','Restricted','Your role does not have access to employee, attendance or payroll records. Ask an owner or manager if you need them.')}</section>;
  const content: Record<string,()=>ReactNode> = { dashboard, pos, orders:ordersView, kitchen, inventory:inventoryView, purchases:purchasesView, customers:customersView, employees:canViewPayroll?employeesView:restrictedView, attendance:canManageHr?attendanceView:restrictedView, payroll:canViewPayroll?payrollView:restrictedView, expenses:expensesView, accounting, reports:reportsView, profit:profitView, qr, settings:apiSettings };
  const activeContent = content[view] ? content[view]() : placeholder();

  return <div className={`${light?'theme-light':''} min-h-screen bg-[#0e1114] text-slate-100`}><div className="flex min-h-screen"><aside className={`fixed inset-y-0 left-0 z-40 flex w-[260px] flex-col border-r border-white/[.06] bg-[#111519] transition-transform lg:static lg:translate-x-0 ${mobileNav?'translate-x-0':'-translate-x-full'}`}><div className="flex h-[76px] items-center gap-3 border-b border-white/[.06] px-5"><div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-[#f0ca69] to-[#b37a18] font-serif text-xl font-black text-[#201707]">M</div><div><div className="font-serif text-lg font-bold tracking-wide text-white">Musafir</div><div className="text-[9px] uppercase tracking-[.28em] text-[#cba84c]">Fast Food</div></div><button onClick={()=>setMobileNav(false)} className="ml-auto text-slate-500 lg:hidden"><X size={19}/></button></div><div className="mx-3 mt-4 flex items-center gap-3 rounded-xl border border-white/[.06] bg-white/[.025] p-3"><div className="grid h-9 w-9 place-items-center rounded-full bg-[#e7b943] text-sm font-bold text-[#211908]">A</div><div className="min-w-0"><div className="text-sm font-medium text-white">Admin</div><div className="text-[11px] text-slate-500">Restaurant owner</div></div><span className="ml-auto h-2 w-2 rounded-full bg-emerald-400"/></div><nav className="custom-scrollbar flex-1 space-y-5 overflow-y-auto px-3 py-5">{moduleGroups.map(group=><div key={group.title}><div className="mb-2 px-3 text-[9px] font-bold uppercase tracking-[.2em] text-slate-600">{group.title}</div><div className="space-y-1">{group.items.map(item=><button key={item.id} onClick={()=>{setView(item.id);setMobileNav(false);}} className={`nav-item ${view===item.id?'nav-active':''}`}><item.icon size={16} strokeWidth={1.8}/><span className="flex-1 text-left">{item.label}</span>{item.id==='pos'&&cart.length>0&&<span className="rounded-full bg-[#e7b943] px-1.5 py-0.5 text-[10px] font-bold text-black">{cart.reduce((n,i)=>n+i.qty,0)}</span>}</button>)}</div></div>)}</nav><div className="border-t border-white/[.06] p-3"><div className="rounded-xl bg-gradient-to-r from-[#211d13] to-[#17191a] p-3"><div className="text-xs font-medium text-[#ead18b]">Good Food • Good Mood</div><div className="mt-1 text-[10px] text-slate-500">Premium service, made simple.</div></div><button onClick={()=>flash('Sign out requires authentication, which is not yet configured.')} className="mt-2 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs text-slate-500 hover:bg-white/[.04] hover:text-slate-300"><LogOut size={15}/>Sign out</button></div></aside>
    {mobileNav&&<button aria-label="Close navigation" onClick={()=>setMobileNav(false)} className="fixed inset-0 z-30 bg-black/60 lg:hidden"/>}<div className="min-w-0 flex-1"><header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-white/[.06] bg-[#101417]/90 px-4 backdrop-blur-xl md:px-7"><div className="flex items-center gap-3"><button onClick={()=>setMobileNav(true)} className="rounded-lg p-2 text-slate-400 hover:bg-white/5 lg:hidden"><Menu size={20}/></button><div className="hidden items-center gap-2 text-xs text-slate-500 sm:flex"><span>Musafir</span><span>/</span><span className="text-slate-200">{selectedLabel}</span></div><div className="sm:hidden text-sm font-medium text-white">{selectedLabel}</div></div><div className="flex items-center gap-2 md:gap-4"><div className="hidden items-center gap-2 rounded-lg border border-white/[.07] bg-white/[.025] px-3 py-2 text-xs text-slate-500 md:flex"><Search size={14}/><span>Search menu items…</span><kbd className="ml-6 rounded border border-white/10 px-1.5 py-0.5 text-[10px]">⌘ K</kbd></div><button onClick={()=>flash(lowStock.length?`${lowStock.length} inventory item(s) are at or below reorder level.`:'No new alerts.')} className="relative rounded-lg p-2 text-slate-400 hover:bg-white/5"><Bell size={18}/>{lowStock.length>0&&<span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-400"/>}</button><button onClick={()=>setLight(value=>!value)} className="rounded-lg border border-white/[.08] px-2.5 py-1.5 text-[11px] text-slate-400">{light?'Light':'Dark'}</button><div className="hidden items-center gap-2 border-l border-white/[.08] pl-3 sm:flex"><div className="text-right"><div className="text-xs font-medium text-slate-200">Admin</div><div className="text-[10px] text-slate-500">Owner</div></div><ChevronDown size={14} className="text-slate-500"/></div></div></header><main className="mx-auto max-w-[1600px] px-4 py-5 md:px-7 md:py-7">{activeContent}<footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-white/[.05] pt-4 text-[10px] text-slate-600"><span>Musafir Fast Food · Restaurant operations</span><span>Good Food • Good Mood</span></footer></main></div></div>{toast&&<div role="status" className="fixed bottom-5 right-5 z-50 max-w-sm rounded-xl border border-[#e7b943]/20 bg-[#1a1e21] px-4 py-3 text-sm text-slate-200 shadow-2xl">{toast}</div>}</div>;
}

export default App;
