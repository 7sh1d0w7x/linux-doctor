# RPM spec for linux-doctor (Fedora / RHEL / COPR).
# Source0 is the npm tarball attached to the GitHub release; it extracts to a
# `package/` directory, hence -n package.
Name:           linux-doctor
Version:        0.7.3
Release:        1%{?dist}
Summary:        Read-only health checks for your Linux system
License:        GPL-3.0-or-later
URL:            https://github.com/7sh1d0w7x/linux-doctor
Source0:        https://github.com/7sh1d0w7x/linux-doctor/releases/download/v%{version}/%{name}-%{version}.tgz
BuildArch:      noarch
Requires:       nodejs >= 20

%description
Linux Doctor runs read-only health checks on your system, explains what went
wrong, and tells you exactly how to fix them. Checks cover memory,
disk, services, security, updates, GPU, network, backups and more — with a
health score, history, and a web dashboard.

%prep
%setup -q -n package

%install
mkdir -p %{buildroot}%{_libdir}/linux-doctor/src-gui %{buildroot}%{_bindir}
cp -r bin src package.json README.md LICENSE %{buildroot}%{_libdir}/linux-doctor/
install -Dm644 src-gui/index.html %{buildroot}%{_libdir}/linux-doctor/src-gui/index.html
ln -s "$(realpath --relative-to=%{buildroot}%{_bindir} %{buildroot}%{_libdir}/linux-doctor/bin/doctor.js)" %{buildroot}%{_bindir}/linux-doctor
chmod 0755 %{buildroot}%{_libdir}/linux-doctor/bin/doctor.js

%files
%{_libdir}/linux-doctor
%{_bindir}/linux-doctor

%changelog
* Sat, Oct 10, 2026 7sh1d0w7x <zshadow7x@users.noreply.github.com> - 0.7.3-1
- Sync to 0.7.3

* Sat, Oct 03, 2026 7sh1d0w7x <zshadow7x@users.noreply.github.com> - 0.7.2-1
- Sync to 0.7.2

* Sat Sep 26 2026 7sh1d0w7x <zshadow7x@users.noreply.github.com> - 0.7.1-1
- Sync to 0.7.1
* Sun Sep 13 2026 7sh1d0w7x <zshadow7x@users.noreply.github.com> - 0.6.0-1
- Sync to 0.6.0

* Sat Sep 05 2026 7sh1d0w7x <zshadow7x@users.noreply.github.com> - 0.5.0-1
- Sync to 0.5.0

* Fri Aug 28 2026 7sh1d0w7x <zshadow7x@users.noreply.github.com> - 0.4.0-1
- Sync to 0.4.0

* Thu Aug 27 2026 7sh1d0w7x <zshadow7x@users.noreply.github.com> - 0.3.5-1
- Sync to 0.3.5

* Thu Aug 27 2026 7sh1d0w7x <zshadow7x@users.noreply.github.com> - 0.3.4-1
- Sync to 0.3.4

* Tue Aug 18 2026 7sh1d0w7x <zshadow7x@users.noreply.github.com> - 0.2.0-1
- Sync to 0.2.0; add audio and containers checks

* Tue Aug 18 2026 7sh1d0w7x <zshadow7x@users.noreply.github.com> - 0.1.0-1
- Initial packaging
