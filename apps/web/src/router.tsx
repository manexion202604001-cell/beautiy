import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, createHashRouter, Navigate, useRouteError } from 'react-router';
import { AppLayout } from './components/layout/AppLayout';
import { RequireAuth } from './components/layout/RequireAuth';
import { ErrorState, PageSpinner } from './components/ui';
import { NotFound } from './routes/NotFound';

// Route-level code splitting keeps the customer booking bundle small (LINE in-app browser)
const Login = lazy(() => import('./routes/auth/Login'));
const Signup = lazy(() => import('./routes/auth/Signup'));
const ForgotPassword = lazy(() => import('./routes/auth/ForgotPassword'));
const ResetPassword = lazy(() => import('./routes/auth/ResetPassword'));
const Invite = lazy(() => import('./routes/auth/Invite'));
const Dashboard = lazy(() => import('./routes/app/Dashboard'));
const CalendarPage = lazy(() => import('./routes/app/Calendar'));
const Reservations = lazy(() => import('./routes/app/reservations/Reservations'));
const ReservationNew = lazy(() => import('./routes/app/reservations/ReservationNew'));
const ReservationDetail = lazy(() => import('./routes/app/reservations/ReservationDetail'));
const Customers = lazy(() => import('./routes/app/customers/Customers'));
const MenuSelect = lazy(() => import('./routes/app/menus/MenuSelect'));
const CustomersList = lazy(() => import('./routes/app/customers/CustomersList'));
const CustomerNew = lazy(() => import('./routes/app/customers/CustomerNew'));
const CustomerDetail = lazy(() => import('./routes/app/customers/CustomerDetail'));
const CustomerCreate = lazy(() => import('./routes/app/customers/CustomerCreate'));
const CustomerShow = lazy(() => import('./routes/app/customers/CustomerShow'));
const KarteShow = lazy(() => import('./routes/app/customers/KarteShow'));
const Duplicates = lazy(() => import('./routes/app/customers/Duplicates'));
const Menus = lazy(() => import('./routes/app/menus/Menus'));
const MenuList = lazy(() => import('./routes/app/menus/MenuList'));
const MenuEdit = lazy(() => import('./routes/app/menus/MenuEdit'));
const MenuCategories = lazy(() => import('./routes/app/menus/MenuCategories'));
const StaffList = lazy(() => import('./routes/app/staff/StaffList'));
const Staff = lazy(() => import('./routes/app/staff/Staff'));
const ReservationSettings = lazy(() => import('./routes/app/ReservationSettings'));
const StaffDetail = lazy(() => import('./routes/app/staff/StaffDetail'));
const Roles = lazy(() => import('./routes/app/staff/Roles'));
const Shifts = lazy(() => import('./routes/app/Shifts'));
const Settings = lazy(() => import('./routes/app/Settings'));
const StoreSettings = lazy(() => import('./routes/app/settings/StoreSettings'));
const ComingSoon = lazy(() => import('./routes/app/ComingSoon'));
const System = lazy(() => import('./routes/app/System'));
const Book = lazy(() => import('./routes/public/Book'));
const Manage = lazy(() => import('./routes/public/Manage'));
const My = lazy(() => import('./routes/public/My'));
// pass2-a: POS / kartes & forms / reviews / commerce (staff) + public pages
const PosHome = lazy(() => import('./routes/app/pos/PosHome'));
const PosCheckout = lazy(() => import('./routes/app/pos/Checkout'));
const PosTransactions = lazy(() => import('./routes/app/pos/TransactionHistory'));
const PosDaily = lazy(() => import('./routes/app/pos/DailyReport'));
const KartesList = lazy(() => import('./routes/app/kartes/KartesList'));
const KarteEditor = lazy(() => import('./routes/app/kartes/KarteEditor'));
const FormTemplates = lazy(() => import('./routes/app/kartes/FormTemplates'));
const ReviewsPage = lazy(() => import('./routes/app/reviews/Reviews'));
const CommercePage = lazy(() => import('./routes/app/commerce/Commerce'));
const KarteShare = lazy(() => import('./routes/public/KarteShare'));
const PublicForm = lazy(() => import('./routes/public/PublicForm'));
const ReviewSubmit = lazy(() => import('./routes/public/ReviewSubmit'));
const StaffProfile = lazy(() => import('./routes/public/reviews/StaffProfile'));
const ShopReviews = lazy(() => import('./routes/public/reviews/ShopReviews'));
const ShopRedirect = lazy(() => import('./routes/public/ShopRedirect'));
const Storefront = lazy(() => import('./routes/public/store/Storefront'));
const StoreProduct = lazy(() => import('./routes/public/store/ProductPage'));
const StoreCart = lazy(() => import('./routes/public/store/CartPage'));
const StoreCheckout = lazy(() => import('./routes/public/store/CheckoutPage'));
const StoreOrder = lazy(() => import('./routes/public/store/OrderStatus'));
// pass2-b: messaging / campaigns / analytics / integrations / ops + public link pages
const Messages = lazy(() => import('./routes/app/messages/Messages'));
const MessageBoard = lazy(() => import('./routes/app/messages/MessageBoard'));
const Consents = lazy(() => import('./routes/app/consents/Consents'));
const WalkinConsent = lazy(() => import('./routes/public/WalkinConsent'));
const Campaigns = lazy(() => import('./routes/app/campaigns/Campaigns'));
const Analytics = lazy(() => import('./routes/app/analytics/Analytics'));
const Integrations = lazy(() => import('./routes/app/integrations/Integrations'));
const Ops = lazy(() => import('./routes/app/ops/Ops'));
const Migration = lazy(() => import('./routes/app/migration/Migration'));
const Unsubscribe = lazy(() => import('./routes/public/Unsubscribe'));
const LineLink = lazy(() => import('./routes/public/LineLink'));
const ShortLink = lazy(() => import('./routes/public/ShortLink'));

const s = (el: ReactNode) => <Suspense fallback={<PageSpinner />}>{el}</Suspense>;

function RouteError() {
  const error = useRouteError();
  return (
    <div className="mx-auto max-w-xl p-6">
      <ErrorState error={error} onRetry={() => window.location.reload()} />
    </div>
  );
}

// The static web demo is served from a single page without server-side routing → hash URLs
const createRouter = import.meta.env.VITE_DEMO ? createHashRouter : createBrowserRouter;

export const router = createRouter([
  { path: '/', element: <Navigate to="/app" replace /> },
  { path: '/login', element: s(<Login />), errorElement: <RouteError /> },
  { path: '/signup', element: s(<Signup />), errorElement: <RouteError /> },
  { path: '/forgot-password', element: s(<ForgotPassword />), errorElement: <RouteError /> },
  { path: '/reset-password/:token', element: s(<ResetPassword />), errorElement: <RouteError /> },
  // without a token in the path (?token= is accepted too); shows "無効なリンクです。" when there is none
  { path: '/reset-password', element: s(<ResetPassword />), errorElement: <RouteError /> },
  { path: '/invite/:token', element: s(<Invite />), errorElement: <RouteError /> },
  { path: '/book/:shopSlug', element: s(<Book />), errorElement: <RouteError /> },
  { path: '/b/manage/:token', element: s(<Manage />), errorElement: <RouteError /> },
  { path: '/my', element: s(<My />), errorElement: <RouteError /> },
  { path: '/my/:shopSlug', element: s(<My />), errorElement: <RouteError /> },
  // pass2-a: public pages for links generated by the API (karte share, forms, reviews, profiles, EC)
  ...[
    { path: '/k/:token', el: <KarteShare /> },
    { path: '/f/:token', el: <PublicForm /> },
    { path: '/review/:token', el: <ReviewSubmit /> },
    { path: '/r/:token', el: <ReviewSubmit /> },
    { path: '/book/:shopSlug/staff/:staffId', el: <StaffProfile /> },
    { path: '/s/:shopSlug/staff/:staffId', el: <StaffProfile /> },
    { path: '/book/:shopSlug/reviews', el: <ShopReviews /> },
    { path: '/s/:shopSlug/reviews', el: <ShopReviews /> },
    { path: '/s/:shopSlug', el: <ShopRedirect /> },
    { path: '/store/products/:id', el: <StoreProduct /> },
    { path: '/store/:shopSlug', el: <Storefront /> },
    { path: '/store/:shopSlug/cart', el: <StoreCart /> },
    { path: '/store/:shopSlug/checkout', el: <StoreCheckout /> },
    { path: '/store/:shopSlug/orders/:orderId', el: <StoreOrder /> },
    { path: '/shop/:shopSlug', el: <Storefront /> },
    { path: '/shop/:shopSlug/products/:id', el: <StoreProduct /> },
  ].map((r) => ({ path: r.path, element: s(r.el), errorElement: <RouteError /> })),
  // pass2-b
  { path: '/unsubscribe', element: s(<Unsubscribe />), errorElement: <RouteError /> },
  { path: '/line/link', element: s(<LineLink />), errorElement: <RouteError /> },
  // reception QR for customers without a reservation (consent + counselling sheets)
  { path: '/consent/:shopSlug', element: s(<WalkinConsent />), errorElement: <RouteError /> },
  { path: '/s/:shopSlug/*', element: s(<ShortLink />), errorElement: <RouteError /> },
  {
    path: '/app',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: s(<Dashboard />) },
      { path: 'calendar', element: s(<Reservations />) },
      { path: 'calendar/new', element: s(<ReservationNew />) },
      { path: 'calendar/:id', element: s(<ReservationDetail />) },
      // previous calendar (slot blocks, drag-resize); linked from 設定 › その他の機能
      { path: 'calendar-classic', element: s(<CalendarPage />) },
      { path: 'customers', element: s(<Customers />) },
      // previous list (tag / visit-date filters, CSV export); linked from 設定 › その他の機能
      { path: 'customers-classic', element: s(<CustomersList />) },
      { path: 'customers/new', element: s(<CustomerCreate />) },
      { path: 'customers/duplicates', element: s(<Duplicates />) },
      { path: 'customers/kartes/:id', element: s(<KarteShow />) },
      { path: 'customers/:id', element: s(<CustomerShow />) },
      // previous customer form / detail (tags, staff memos, points, documents, merge history)
      { path: 'customers-classic/new', element: s(<CustomerNew />) },
      { path: 'customers-classic/:id', element: s(<CustomerDetail />) },
      { path: 'menus', element: s(<MenuList />) },
      { path: 'menus/select', element: s(<MenuSelect />) },
      { path: 'menus/categories', element: s(<MenuCategories />) },
      { path: 'menus/new', element: s(<MenuEdit />) },
      { path: 'menus/:id', element: s(<MenuEdit />) },
      // previous screen (per-shop price overrides, tax, buffers, discount coupons, seats / equipment);
      // linked from 設定 › その他の機能
      { path: 'menus-classic', element: s(<Menus />) },
      { path: 'staff', element: s(<Staff />) },
      { path: 'staff/roles', element: s(<Roles />) },
      // previous staff screens (detail tabs, transfer between shops, staff without e-mail); linked from 設定 › その他の機能
      { path: 'staff-classic', element: s(<StaffList />) },
      { path: 'staff-classic/:id', element: s(<StaffDetail />) },
      { path: 'staff/:id', element: s(<StaffDetail />) },
      { path: 'shifts', element: s(<Shifts />) },
      { path: 'settings', element: s(<StoreSettings />) },
      // previous 店舗設定 (business hours, holidays, booking rules, 法人設定); linked from 設定 › その他の機能
      { path: 'settings-classic', element: s(<Settings />) },
      // main-menu entries whose screens are not rebuilt yet reuse the existing ones
      { path: 'reservation-settings', element: s(<ReservationSettings />) },
      { path: 'consents', element: s(<Consents />) },
      { path: 'system', element: s(<System />) },
      { path: 'soon/:feature', element: s(<ComingSoon />) },
      // pass2-a
      { path: 'pos', element: s(<PosHome />) },
      { path: 'pos/checkout/:transactionId', element: s(<PosCheckout />) },
      { path: 'pos/transactions', element: s(<PosTransactions />) },
      { path: 'pos/daily', element: s(<PosDaily />) },
      { path: 'kartes', element: s(<KartesList />) },
      { path: 'kartes/forms', element: s(<FormTemplates />) },
      { path: 'kartes/new', element: s(<KarteEditor />) },
      { path: 'kartes/:id', element: s(<KarteEditor />) },
      { path: 'reviews', element: s(<ReviewsPage />) },
      { path: 'commerce', element: s(<CommercePage />) },
      // pass2-b
      { path: 'messages', element: s(<MessageBoard />) },
      // previous inbox (AI drafts, templates, channel choice); linked from 設定 › その他の機能
      { path: 'messages-classic', element: s(<Messages />) },
      { path: 'campaigns', element: s(<Campaigns />) },
      { path: 'analytics', element: s(<Analytics />) },
      { path: 'integrations', element: s(<Integrations />) },
      { path: 'ops', element: s(<Ops />) },
      { path: 'migration', element: s(<Migration />) },
      { path: '*', element: <NotFound inApp /> },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
