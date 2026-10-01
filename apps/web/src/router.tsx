import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, useRouteError } from 'react-router';
import { AppLayout } from './components/layout/AppLayout';
import { RequireAuth } from './components/layout/RequireAuth';
import { ErrorState, PageSpinner } from './components/ui';
import { NotFound } from './routes/NotFound';

// Route-level code splitting keeps the customer booking bundle small (LINE in-app browser)
const Login = lazy(() => import('./routes/auth/Login'));
const Signup = lazy(() => import('./routes/auth/Signup'));
const Invite = lazy(() => import('./routes/auth/Invite'));
const Dashboard = lazy(() => import('./routes/app/Dashboard'));
const CalendarPage = lazy(() => import('./routes/app/Calendar'));
const CustomersList = lazy(() => import('./routes/app/customers/CustomersList'));
const CustomerNew = lazy(() => import('./routes/app/customers/CustomerNew'));
const CustomerDetail = lazy(() => import('./routes/app/customers/CustomerDetail'));
const Duplicates = lazy(() => import('./routes/app/customers/Duplicates'));
const Menus = lazy(() => import('./routes/app/menus/Menus'));
const StaffList = lazy(() => import('./routes/app/staff/StaffList'));
const StaffDetail = lazy(() => import('./routes/app/staff/StaffDetail'));
const Roles = lazy(() => import('./routes/app/staff/Roles'));
const Shifts = lazy(() => import('./routes/app/Shifts'));
const Settings = lazy(() => import('./routes/app/Settings'));
const ComingSoon = lazy(() => import('./routes/app/ComingSoon'));
const Book = lazy(() => import('./routes/public/Book'));
const Manage = lazy(() => import('./routes/public/Manage'));
const My = lazy(() => import('./routes/public/My'));

const s = (el: ReactNode) => <Suspense fallback={<PageSpinner />}>{el}</Suspense>;

function RouteError() {
  const error = useRouteError();
  return (
    <div className="mx-auto max-w-xl p-6">
      <ErrorState error={error} onRetry={() => window.location.reload()} />
    </div>
  );
}

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/app" replace /> },
  { path: '/login', element: s(<Login />), errorElement: <RouteError /> },
  { path: '/signup', element: s(<Signup />), errorElement: <RouteError /> },
  { path: '/invite/:token', element: s(<Invite />), errorElement: <RouteError /> },
  { path: '/book/:shopSlug', element: s(<Book />), errorElement: <RouteError /> },
  { path: '/b/manage/:token', element: s(<Manage />), errorElement: <RouteError /> },
  { path: '/my', element: s(<My />), errorElement: <RouteError /> },
  { path: '/my/:shopSlug', element: s(<My />), errorElement: <RouteError /> },
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
      { path: 'calendar', element: s(<CalendarPage />) },
      { path: 'customers', element: s(<CustomersList />) },
      { path: 'customers/new', element: s(<CustomerNew />) },
      { path: 'customers/duplicates', element: s(<Duplicates />) },
      { path: 'customers/:id', element: s(<CustomerDetail />) },
      { path: 'menus', element: s(<Menus />) },
      { path: 'staff', element: s(<StaffList />) },
      { path: 'staff/roles', element: s(<Roles />) },
      { path: 'staff/:id', element: s(<StaffDetail />) },
      { path: 'shifts', element: s(<Shifts />) },
      { path: 'settings', element: s(<Settings />) },
      { path: 'soon/:feature', element: s(<ComingSoon />) },
      { path: '*', element: <NotFound inApp /> },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
